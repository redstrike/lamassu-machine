'use strict'

const machina = require('machina')
const crc = require('../lib/id003/crc')

const ETX = 0x03
const ENQ = 0x05
const ACK = 0x06
const NAK = 0x15
const DLE = 0x10
const DLE_ACK = new Buffer([DLE, ACK])
const DLE_NAK = new Buffer([DLE, NAK])
const DLE_ETX = new Buffer([DLE, ETX])
const DLE_ENQ = new Buffer([DLE, ENQ])

const fsm = new machina.Fsm({
  initialState: 'Idle',
  states: {
    Idle: {
      // Note: This has to be a regular function and must use "this" because fsm
      // isn't defined yet.
      _onEnter: function () {
        this.retryDleAckCount = 0
        this.retryAckCount = 0
        this.transmitData = null
      },
      'Send': data => {
        fsm.transmitData = data
        fsm.transition('DLE_ENQ_T')
      },
      DLE: 'ENQ',
      LineError: nakEnq
    },
    ENQ: {
      _onEnter: startTimer,
      ENQ: () => {
        fsm.emit('send', DLE_ACK)
        fsm.transition('DLE_STX')
      },
      Timeout: nakEnq,
      LineError: nakEnq,
      '*': 'Idle',
      _onExit: clearTimer
    },
    DLE_STX: {
      _onEnter: () => {
        startTimer()
        fsm.dataLengthBuf = new Buffer(0)
        fsm.dataLength = null
        fsm.data = new Buffer(0)
        fsm.crc = new Buffer(0)
      },
      DLE: 'STX',
      Timeout: 'Idle',
      LineError: nakEnq,
      '*': 'ENQ',
      _onExit: clearTimer
    },
    STX: {
      _onEnter: startTimer,
      DLE: 'DLE_STX',
      ENQ: () => {
        fsm.emit('send', DLE_ACK)
        fsm.transition('DLE_STX')
      },
      STX: 'DataLength',
      '*': nakEnq,
      _onExit: clearTimer
    },
    DataLength: {
      _onEnter: startTimer,
      Timeout: nakStx,
      LineError: nakStx,
      Data: byte => {
        fsm.dataLengthBuf = Buffer.concat([fsm.dataLengthBuf, new Buffer([byte])])
        if (fsm.dataLengthBuf.length === 2) fsm.transition('Data')
      },
      _onExit: clearTimer
    },
    Data: {
      _onEnter: startTimer,
      Timeout: nakStx,
      LineError: nakStx,
      Data: byte => {
        fsm.dataLength = fsm.dataLength || fsm.dataLengthBuf.readUInt16BE(0)
        fsm.data = Buffer.concat([fsm.data, new Buffer([byte])])
        if (fsm.data.length === fsm.dataLength) fsm.transition('DLE_ETX')
      },
      _onExit: clearTimer
    },
    DLE_ETX: {
      _onEnter: startTimer,
      DLE: 'ETX',
      '*': nakStx,
      _onExit: clearTimer
    },
    ETX: {
      _onEnter: startTimer,
      ETX: 'CRC',
      '*': nakStx,
      _onExit: clearTimer
    },
    CRC: {
      _onEnter: startTimer,
      Timeout: nakStx,
      LineError: nakStx,
      'Data': byte => {
        fsm.crc = Buffer.concat([fsm.crc, new Buffer([byte])])
        if (fsm.crc.length === 2) fsm.transition('CRC_Check')
      },
      _onExit: clearTimer
    },
    CRC_Check: {
      _onEnter: () => {
        const buf = Buffer.concat([fsm.dataLengthBuf, fsm.data, DLE_ETX])
        const computedCrc = crc.compute(buf)

        if (fsm.crc.readUInt16LE(0) === computedCrc) {
          fsm.emit('send', DLE_ACK)
          fsm.emit('frame', fsm.data)
          fsm.transition('Idle')
          return
        }

        console.log('DEBUG2: CRC failure')
        nakStx()
      }
    },
    DLE_ENQ_T: {
      '*': () => {
        fsm.emit('send', DLE_ENQ)
        fsm.transition('DLE_ACK')
      }
    },
    DLE_ACK: {
      _onEnter: startTimer,
      DLE: 'ACK',
      Timeout: retryDleAck,
      LineError: retryDleAck,
      _onExit: clearTimer
    },
    ACK: {
      _onEnter: () => {
        startTimer()
        fsm.retryDleAckCount = 0
      },
      ENQ: 'DLE_ENQ_T',
      ACK: 'Transmit',
      Timeout: retryAck,
      LineError: retryAck,
      '*': 'DLE_ACK',
      _onExit: clearTimer
    },
    Transmit: {
      _onEnter: () => {
        resetRetry()
        fsm.retryAckCount = 0
      },
      '*': () => {
        fsm.emit('send', fsm.transmitData)
        fsm.transition('DLE_ACK_2')
      }
    },
    DLE_ACK_2: {
      _onEnter: startTimer,
      DLE: 'ACK_2',
      Timeout: retryDleAck2,
      LineError: retryDleAck2,
      _onExit: clearTimer
    },
    ACK_2: {
      _onEnter: () => {
        startTimer()
        fsm.retryDleAckCount = 0
      },
      ENQ: 'Idle',
      ACK: () => {
        fsm.emit('status', 'transmissionComplete')
        fsm.transition('Idle')
      },
      NAK: retryAck2,
      Timeout: retryAck2,
      LineError: retryAck2,
      '*': 'DLE_ACK_2',
      _onExit: clearTimer
    }
  }
})

function resetRetry () {
  fsm.retryCount = 0
}

function retryDleAck2 () {
  fsm.retryDleAckCount = fsm.retryDleAckCount + 1
  if (fsm.retryDleAckCount < 3) return fsm.transition('Transmit')
  fsm.emit('status', 'transmissionFailure')
  fsm.transition('Idle')
}

function retryAck2 () {
  fsm.retryAckCount++
  if (fsm.retryAckCount < 3) return fsm.transition('Transmit')
  fsm.emit('status', 'transmissionFailure')
  fsm.transition('Idle')
}

function retryAck () {
  fsm.retryAckCount++
  if (fsm.retryAckCount < 3) return fsm.transition('DLE_ENQ_T')
  fsm.emit('status', 'transmissionFailure')
  fsm.transition('Idle')
}

function retryDleAck () {
  fsm.retryDleAckCount++
  if (fsm.retryDleAckCount < 3) return fsm.transition('DLE_ENQ_T')
  fsm.emit('status', 'transmissionFailure')
  fsm.transition('Idle')
}

function nakStx () {
  fsm.emit('send', DLE_NAK)
  fsm.transition('DLE_STX')
}

function nakEnq () {
  fsm.emit('NAK')
  fsm.transition('Idle')
}

function startTimer () {
  fsm.timerId = setTimeout(() => fsm.handle('Timeout'), 5000)
}

function clearTimer () {
  clearTimeout(fsm.timerId)
}

function prettyHex (buf) {
  const pairs = []
  for (let i = 0; i < buf.length; i++) {
    pairs.push((buf.slice(i, i + 1).toString('hex')))
  }

  return pairs.join(' ')
}

fsm.on('send', s => console.log('send: %s', prettyHex(s)))
fsm.on('transition', r => console.log('%s: %s -> %s', r.action, r.fromState, r.toState))
fsm.on('status', r => console.log)
fsm.on('frame', r => console.log('frame: %s', prettyHex(r)))

module.exports = fsm

/*
TODO
  - keep thinking about retry, might need multiple counts
*/
