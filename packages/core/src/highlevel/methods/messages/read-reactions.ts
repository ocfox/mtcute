import type { ITelegramClient } from '../../client.types.js'
import type { InputPeerLike } from '../../types/index.js'
import { createDummyUpdate } from '../../updates/utils.js'
import { resolvePeer } from '../users/resolve-peer.js'

/**
 * Mark all reactions in chat as read.
 *
 * @param chatId  Chat ID
 */
export async function readReactions(
    client: ITelegramClient,
    chatId: InputPeerLike,
    params?: {
        /**
         * Whether to dispatch updates that will be generated by this call.
         * Doesn't follow `disableNoDispatch`
         */
        shouldDispatch?: true
    },
): Promise<void> {
    const { shouldDispatch } = params ?? {}
    const res = await client.call({
        _: 'messages.readReactions',
        peer: await resolvePeer(client, chatId),
    })

    if (!shouldDispatch) {
        client.handleClientUpdate(createDummyUpdate(res.pts, res.ptsCount))
    }
}
