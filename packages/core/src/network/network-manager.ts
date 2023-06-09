import { tl } from '@mtcute/tl'
import { TlReaderMap, TlWriterMap } from '@mtcute/tl-runtime'

import { ITelegramStorage } from '../storage'
import { ICryptoProvider, Logger } from '../utils'
import { ConfigManager } from './config-manager'
import { MultiSessionConnection } from './multi-session-connection'
import { PersistentConnectionParams } from './persistent-connection'
import {
    defaultReconnectionStrategy,
    ReconnectionStrategy,
} from './reconnection'
import {
    SessionConnection,
    SessionConnectionParams,
} from './session-connection'
import { defaultTransportFactory, TransportFactory } from './transports'

export type ConnectionKind = 'main' | 'upload' | 'download' | 'download-small'

/**
 * Params passed into {@link NetworkManager} by {@link TelegramClient}.
 * This type is intended for internal usage only.
 */
export interface NetworkManagerParams {
    storage: ITelegramStorage
    crypto: ICryptoProvider
    log: Logger

    apiId: number
    initConnectionOptions?: Partial<
        Omit<tl.RawInitConnectionRequest, 'apiId' | 'query'>
    >
    transport?: TransportFactory
    reconnectionStrategy?: ReconnectionStrategy<PersistentConnectionParams>

    disableUpdates?: boolean
    testMode: boolean
    layer: number
    readerMap: TlReaderMap
    writerMap: TlWriterMap
    _emitError: (err: Error, connection?: SessionConnection) => void
}

/**
 * Additional params passed into {@link NetworkManager} by the user
 * that customize the behavior of the manager
 */
export interface NetworkManagerExtraParams {
    /**
     * Whether to use PFS (Perfect Forward Secrecy) for all connections.
     * This is disabled by default
     */
    usePfs?: boolean

    /**
     * Connection count for each connection kind
     */
    connectionCount?: Partial<Record<ConnectionKind, number>>
}

export class DcConnectionManager {
    private __baseConnectionParams = (): SessionConnectionParams => ({
        crypto: this.manager.params.crypto,
        initConnection: this.manager._initConnectionParams,
        transportFactory: this.manager._transportFactory,
        dc: this._dc,
        testMode: this.manager.params.testMode,
        reconnectionStrategy: this.manager._reconnectionStrategy,
        layer: this.manager.params.layer,
        disableUpdates: this.manager.params.disableUpdates,
        readerMap: this.manager.params.readerMap,
        writerMap: this.manager.params.writerMap,
        usePfs: this.manager.params.usePfs,
        isMainConnection: false,
    })

    mainConnection = new MultiSessionConnection(
        {
            ...this.__baseConnectionParams(),
            isMainConnection: true,
        },
        this.manager.params.connectionCount?.main ?? 1,
        this.manager._log,
    )

    constructor(
        readonly manager: NetworkManager,
        readonly dcId: number,
        private _dc: tl.RawDcOption,
    ) {
        this._setupMulti(this.mainConnection, 'main')
    }

    private _setupMulti(
        connection: MultiSessionConnection,
        kind: ConnectionKind,
    ): void {
        connection.on('key-change', (idx, key) => {
            if (kind !== 'main') {
                // main connection is responsible for authorization,
                // and keys are then sent to other connections
                this.manager._log.warn(
                    'got key-change from non-main connection',
                )

                return
            }

            this.manager._log.debug(
                'key change for dc %d from connection %d',
                this.dcId,
                idx,
            )
            this.manager._storage.setAuthKeyFor(this.dcId, key)

            // send key to other connections
            // todo
        })
        connection.on('tmp-key-change', (idx, key, expires) => {
            if (kind !== 'main') {
                this.manager._log.warn(
                    'got tmp-key-change from non-main connection',
                )

                return
            }

            this.manager._log.debug(
                'temp key change for dc %d from connection %d',
                this.dcId,
                idx,
            )
            this.manager._storage.setTempAuthKeyFor(
                this.dcId,
                idx,
                key,
                expires * 1000,
            )
        })

        connection.on('auth-begin', () => {
            // we need to propagate auth-begin to all connections
            // to avoid them sending requests before auth is complete
            if (kind !== 'main') {
                this.manager._log.warn(
                    'got auth-begin from non-main connection',
                )

                return
            }

            // reset key on non-main connections
            // this event was already propagated to additional main connections
            // todo
        })

        connection.on('request-auth', () => {
            this.mainConnection.requestAuth()
        })
    }

    async loadKeys(): Promise<void> {
        const permanent = await this.manager._storage.getAuthKeyFor(this.dcId)

        await this.mainConnection.setAuthKey(permanent)

        if (this.manager.params.usePfs) {
            for (let i = 0; i < this.mainConnection._sessions.length; i++) {
                const temp = await this.manager._storage.getAuthKeyFor(
                    this.dcId,
                    i,
                )
                await this.mainConnection.setAuthKey(temp, true, i)
            }
        }
    }
}

export class NetworkManager {
    readonly _log = this.params.log.create('network')
    readonly _storage = this.params.storage

    readonly _initConnectionParams: tl.RawInitConnectionRequest
    readonly _transportFactory: TransportFactory
    readonly _reconnectionStrategy: ReconnectionStrategy<PersistentConnectionParams>

    protected readonly _dcConnections: Record<number, DcConnectionManager> = {}
    protected _primaryDc?: DcConnectionManager

    private _keepAliveInterval?: NodeJS.Timeout
    private _keepAliveAction = this._defaultKeepAliveAction.bind(this)
    private _lastUpdateTime = 0
    private _updateHandler: (upd: tl.TypeUpdates) => void = () => {}

    private _defaultKeepAliveAction(): void {
        if (this._keepAliveInterval) return

        // todo
        // telegram asks to fetch pending updates
        // if there are no updates for 15 minutes.
        // core does not have update handling,
        // so we just use getState so the server knows
        // we still do need updates
        // this.call({ _: 'updates.getState' }).catch((e) => {
        //     if (!(e instanceof tl.errors.RpcError)) {
        //         this.primaryConnection.reconnect()
        //     }
        // })
    }

    constructor(
        readonly params: NetworkManagerParams & NetworkManagerExtraParams,
        readonly config: ConfigManager,
    ) {
        let deviceModel = 'mtcute on '
        let appVersion = 'unknown'
        if (typeof process !== 'undefined' && typeof require !== 'undefined') {
            // eslint-disable-next-line @typescript-eslint/no-var-requires
            const os = require('os')
            deviceModel += `${os.type()} ${os.arch()} ${os.release()}`

            try {
                // for production builds
                // eslint-disable-next-line @typescript-eslint/no-var-requires
                appVersion = require('../package.json').version
            } catch (e) {
                try {
                    // for development builds (additional /src/ in path)
                    // eslint-disable-next-line @typescript-eslint/no-var-requires
                    appVersion = require('../../package.json').version
                } catch (e) {}
            }
        } else if (typeof navigator !== 'undefined') {
            deviceModel += navigator.userAgent
        } else deviceModel += 'unknown'

        this._initConnectionParams = {
            _: 'initConnection',
            deviceModel,
            systemVersion: '1.0',
            appVersion,
            systemLangCode: 'en',
            langPack: '', // "langPacks are for official apps only"
            langCode: 'en',
            ...(params.initConnectionOptions ?? {}),
            apiId: params.apiId,
            // eslint-disable-next-line @typescript-eslint/no-explicit-any
            query: null as any,
        }

        this._transportFactory = params.transport ?? defaultTransportFactory
        this._reconnectionStrategy =
            params.reconnectionStrategy ?? defaultReconnectionStrategy

        // this._dcConnections[params.defaultDc?.id ?? 2] =
        //     new DcConnectionManager(this, params.defaultDc?.id ?? 2)
    }

    private _switchPrimaryDc(dc: DcConnectionManager) {
        if (this._primaryDc && this._primaryDc !== dc) {
            // todo clean up
            return
        }

        this._primaryDc = dc

        dc.mainConnection.on('usable', () => {
            this._lastUpdateTime = Date.now()

            if (this._keepAliveInterval) clearInterval(this._keepAliveInterval)
            this._keepAliveInterval = setInterval(async () => {
                if (Date.now() - this._lastUpdateTime > 900_000) {
                    this._keepAliveAction()
                    this._lastUpdateTime = Date.now()
                }
            }, 60_000)
        })
        dc.mainConnection.on('update', (update) => {
            this._lastUpdateTime = Date.now()
            this._updateHandler(update)
        })
        // dc.mainConnection.on('wait', () =>
        //     this._cleanupPrimaryConnection()
        // )
        dc.mainConnection.on('error', (err, conn) =>
            this.params._emitError(err, conn),
        )
        dc.loadKeys()
            .catch((e) => this.params._emitError(e))
            .then(() => dc.mainConnection.connect())
    }

    /**
     * Perform initial connection to the default DC
     *
     * @param defaultDc  Default DC to connect to
     */
    connect(defaultDc: tl.RawDcOption): void {
        if (this._dcConnections[defaultDc.id]) {
            // shouldn't happen
            throw new Error('DC manager already exists')
        }

        this._dcConnections[defaultDc.id] = new DcConnectionManager(
            this,
            defaultDc.id,
            defaultDc,
        )
        this._switchPrimaryDc(this._dcConnections[defaultDc.id])
    }

    destroy(): void {
        for (const dc of Object.values(this._dcConnections)) {
            dc.mainConnection.destroy()
        }
        if (this._keepAliveInterval) clearInterval(this._keepAliveInterval)
    }
}
