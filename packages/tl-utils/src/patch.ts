import { TlReaderMap, TlWriterMap } from '@mtcute/tl-runtime'

import { generateReaderCodeForTlEntries } from './codegen/reader'
import { generateWriterCodeForTlEntries } from './codegen/writer'
import { parseTlToEntries } from './parse'

function evalForResult<T>(js: string): T {
    return new Function(js)()
}

/**
 * Patch runtime TL schema (readers and writers map) with the given schema.
 *
 * Entries in the schema will override the ones in the existing one.
 * Original readers and writers will be preserved, new ones will be returned.
 *
 * @param schema  Schema containing new entries
 * @param readers  Original readers map
 * @param writers  Original writers map
 * @returns  New readers and writers map
 */
export function patchRuntimeTlSchema(
    schema: string,
    readers: TlReaderMap,
    writers: TlWriterMap,
): {
    readerMap: TlReaderMap
    writerMap: TlWriterMap
} {
    const entries = parseTlToEntries(schema)

    const readersCode = generateReaderCodeForTlEntries(entries, {
        variableName: '_',
        includeMethods: false,
    })
    const writersCode = generateWriterCodeForTlEntries(entries, {
        variableName: '_',
        includePrelude: true,
    })

    const newReaders = evalForResult<TlReaderMap>(
        readersCode.replace('var _=', 'return'),
    )
    const newWriters = evalForResult<TlWriterMap>(
        writersCode.replace('var _=', 'return'),
    )

    return {
        readerMap: {
            ...readers,
            ...newReaders,
        },
        writerMap: {
            ...writers,
            ...newWriters,
        },
    }
}
