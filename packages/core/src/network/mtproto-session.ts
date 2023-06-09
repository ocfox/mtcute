import Long from 'long'

import { mtp, tl } from '@mtcute/tl'
import {
    TlBinaryWriter,
    TlReaderMap,
    TlSerializationCounter,
    TlWriterMap,
} from '@mtcute/tl-runtime'

import { ControllablePromise,
    Deque,
    getRandomInt,
    ICryptoProvider,
    Logger,
    LongMap,
    LruSet,
    randomLong,
    SortedArray,
} from '../utils'
import { AuthKey } from './auth-key'

export interface PendingRpc {
    method: string
    data: Buffer
    promise: ControllablePromise
    stack?: string
    gzipOverhead?: number

    sent?: boolean
    msgId?: Long
    seqNo?: number
    containerId?: Long
    acked?: boolean
    initConn?: boolean
    getState?: number
    cancelled?: boolean
    timeout?: NodeJS.Timeout
}

export type PendingMessage =
    | {
          _: 'rpc'
          rpc: PendingRpc
      }
    | {
          _: 'container'
          msgIds: Long[]
      }
    | {
          _: 'state'
          msgIds: Long[]
          containerId: Long
      }
    | {
          _: 'resend'
          msgIds: Long[]
          containerId: Long
      }
    | {
          _: 'ping'
          pingId: Long
          containerId: Long
      }
    | {
          _: 'destroy_session'
          sessionId: Long
          containerId: Long
      }
    | {
          _: 'cancel'
          msgId: Long
          containerId: Long
      }
    | {
          _: 'future_salts'
          containerId: Long
      }
    | {
          _: 'bind'
          promise: ControllablePromise
      }

/**
 * Class encapsulating a single MTProto session and storing
 * all the relevant state
 */
export class MtprotoSession {
    _sessionId = randomLong()

    _authKey = new AuthKey(this._crypto, this.log, this._readerMap)
    _authKeyTemp = new AuthKey(this._crypto, this.log, this._readerMap)
    _authKeyTempSecondary = new AuthKey(this._crypto, this.log, this._readerMap)

    _timeOffset = 0
    _lastMessageId = Long.ZERO
    _seqNo = 0

    serverSalt = Long.ZERO

    /// state ///
    // recent msg ids
    recentOutgoingMsgIds = new LruSet<Long>(1000, false, true)
    recentIncomingMsgIds = new LruSet<Long>(1000, false, true)

    // queues
    queuedRpc = new Deque<PendingRpc>()
    queuedAcks: Long[] = []
    queuedStateReq: Long[] = []
    queuedResendReq: Long[] = []
    queuedCancelReq: Long[] = []
    getStateSchedule = new SortedArray<PendingRpc>(
        [],
        (a, b) => a.getState! - b.getState!,
    )

    // requests info
    pendingMessages = new LongMap<PendingMessage>()
    destroySessionIdToMsgId = new LongMap<Long>()

    initConnectionCalled = false
    authorizationPending = false

    constructor(
        readonly _crypto: ICryptoProvider,
        readonly log: Logger,
        readonly _readerMap: TlReaderMap,
        readonly _writerMap: TlWriterMap,
    ) {
        this.log.prefix = `[SESSION ${this._sessionId.toString(16)}] `
    }

    /**
     * Reset session by resetting auth key(s) and session state
     */
    reset(withAuthKey = false): void {
        if (withAuthKey) {
            this._authKey.reset()
            this._authKeyTemp.reset()
            this._authKeyTempSecondary.reset()
        }

        this.resetState()
    }

    /**
     * Reset session state and generate a new session ID.
     *
     * By default, also cancels any pending RPC requests.
     * If `keepPending` is set to `true`, pending requests will be kept
     */
    resetState(keepPending = false): void {
        this._lastMessageId = Long.ZERO
        this._seqNo = 0

        this._sessionId = randomLong()
        this.log.debug('session reset, new sid = %h', this._sessionId)
        this.log.prefix = `[SESSION ${this._sessionId.toString(16)}] `

        // reset session state

        if (!keepPending) {
            for (const info of this.pendingMessages.values()) {
                if (info._ === 'rpc') {
                    info.rpc.promise.reject(new Error('Session is reset'))
                }
            }
            this.pendingMessages.clear()
        }

        this.recentOutgoingMsgIds.clear()
        this.recentIncomingMsgIds.clear()

        if (!keepPending) {
            while (this.queuedRpc.length) {
                const rpc = this.queuedRpc.popFront()!

                if (rpc.sent === false) {
                    rpc.promise.reject(new Error('Session is reset'))
                }
            }
        }

        this.queuedAcks.length = 0
        this.queuedStateReq.length = 0
        this.queuedResendReq.length = 0
        this.getStateSchedule.clear()
    }

    enqueueRpc(rpc: PendingRpc, force?: boolean): boolean {
        // already queued or cancelled
        if ((!force && !rpc.sent) || rpc.cancelled) return false

        rpc.sent = false
        rpc.containerId = undefined
        this.log.debug(
            'enqueued %s for sending (msg_id = %s)',
            rpc.method,
            rpc.msgId || 'n/a',
        )
        this.queuedRpc.pushBack(rpc)

        return true
    }

    getMessageId(): Long {
        const timeTicks = Date.now()
        const timeSec = Math.floor(timeTicks / 1000) + this._timeOffset
        const timeMSec = timeTicks % 1000
        const random = getRandomInt(0xffff)

        let messageId = new Long((timeMSec << 21) | (random << 3) | 4, timeSec)

        if (this._lastMessageId.gt(messageId)) {
            messageId = this._lastMessageId.add(4)
        }

        this._lastMessageId = messageId

        return messageId
    }

    getSeqNo(isContentRelated = true): number {
        let seqNo = this._seqNo * 2

        if (isContentRelated) {
            seqNo += 1
            this._seqNo += 1
        }

        return seqNo
    }

    /** Encrypt a single MTProto message using session's keys */
    async encryptMessage(message: Buffer): Promise<Buffer> {
        const key = this._authKeyTemp.ready ? this._authKeyTemp : this._authKey

        return key.encryptMessage(message, this.serverSalt, this._sessionId)
    }

    /** Decrypt a single MTProto message using session's keys */
    async decryptMessage(
        data: Buffer,
        callback: Parameters<AuthKey['decryptMessage']>[2],
    ): Promise<void> {
        if (!this._authKey.ready) throw new Error('Keys are not set up!')

        const authKeyId = data.slice(0, 8)

        let key: AuthKey

        if (this._authKey.match(authKeyId)) {
            key = this._authKey
        } else if (this._authKeyTemp.match(authKeyId)) {
            key = this._authKeyTemp
        } else if (this._authKeyTempSecondary.match(authKeyId)) {
            key = this._authKeyTempSecondary
        } else {
            this.log.warn(
                'received message with unknown authKey = %h (expected %h or %h or %h)',
                authKeyId,
                this._authKey.id,
                this._authKeyTemp.id,
                this._authKeyTempSecondary.id,
            )

            return
        }

        return key.decryptMessage(data, this._sessionId, callback)
    }

    writeMessage(
        writer: TlBinaryWriter,
        content: tl.TlObject | mtp.TlObject | Buffer,
        isContentRelated = true,
    ): Long {
        const messageId = this.getMessageId()
        const seqNo = this.getSeqNo(isContentRelated)

        const length = Buffer.isBuffer(content) ?
            content.length :
            TlSerializationCounter.countNeededBytes(
                  writer.objectMap!,
                  content,
            )

        writer.long(messageId)
        writer.int(seqNo)
        writer.uint(length)
        if (Buffer.isBuffer(content)) writer.raw(content)
        else writer.object(content as tl.TlObject)

        return messageId
    }
}
