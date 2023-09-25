import { MtArgumentError, tl } from '@mtcute/core'

import { ArrayWithTotal, MaybeDynamic, Message } from '../types'

/**
 * Normalize phone number by stripping formatting
 * @param phone  Phone number
 */
export function normalizePhoneNumber(phone: string): string {
    phone = phone.trim().replace(/[+()\s-]/g, '')
    if (!phone.match(/^\d+$/)) throw new MtArgumentError('Invalid phone number')

    return phone
}

export async function resolveMaybeDynamic<T>(val: MaybeDynamic<T>): Promise<T> {
    return val instanceof Function ? await val() : await val
}

export function makeArrayWithTotal<T>(arr: T[], total: number): ArrayWithTotal<T> {
    Object.defineProperty(arr, 'total', {
        value: total,
        enumerable: false,
        configurable: false,
        writable: false,
    })

    return arr as ArrayWithTotal<T>
}

export function extractChannelIdFromUpdate(upd: tl.TypeUpdate): number | undefined {
    // holy shit
    let res = 0

    if ('channelId' in upd) {
        res = upd.channelId
    } else if (
        'message' in upd &&
        typeof upd.message !== 'string' &&
        'peerId' in upd.message &&
        upd.message.peerId &&
        'channelId' in upd.message.peerId
    ) {
        res = upd.message.peerId.channelId
    }

    if (res === 0) return undefined

    return res
}

export function normalizeDate(date: Date | number | undefined): number | undefined {
    return date ? ~~((typeof date === 'number' ? date : date.getTime()) / 1000) : undefined
}

export function normalizeMessageId(msg: Message | number | undefined): number | undefined {
    if (!msg) return undefined

    return typeof msg === 'number' ? msg : msg.id
}
