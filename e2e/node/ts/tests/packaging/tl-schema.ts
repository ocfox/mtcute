import { expect } from 'chai'
import Long from 'long'
import { describe, it } from 'mocha'
import { setPlatform } from '@mtcute/core/platform.js'
import { NodePlatform } from '@mtcute/node'
import { tl } from '@mtcute/tl'
import { __tlReaderMap } from '@mtcute/tl/binary/reader.js'
import { __tlWriterMap } from '@mtcute/tl/binary/writer.js'
import { TlBinaryReader, TlBinaryWriter } from '@mtcute/tl-runtime'

// here we primarily want to check that @mtcute/tl correctly works with @mtcute/tl-runtime

const p = new NodePlatform()
setPlatform(p)

describe('@mtcute/tl', () => {
    it('writers map works with TlBinaryWriter', () => {
        const obj = {
            _: 'inputPeerUser',
            userId: 123,
            accessHash: Long.fromNumber(456),
        }

        expect(p.hexEncode(TlBinaryWriter.serializeObject(__tlWriterMap, obj))).to.equal(
            '4ca5e8dd7b00000000000000c801000000000000',
        )
    })

    it('readers map works with TlBinaryReader', () => {
        const buf = p.hexDecode('4ca5e8dd7b00000000000000c801000000000000')
        // eslint-disable-next-line
        const obj = TlBinaryReader.deserializeObject<any>(__tlReaderMap, buf)

        expect(obj._).equal('inputPeerUser')
        expect(obj.userId).equal(123)
        // eslint-disable-next-line
        expect(obj.accessHash.toString()).equal('456')
    })

    it('correctly checks for combinator types', () => {
        expect(tl.isAnyInputUser({ _: 'inputUserEmpty' })).to.eq(true)
    })
})
