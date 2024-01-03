import { Statement } from 'better-sqlite3'

import { IAuthKeysRepository } from '@mtcute/core/src/storage/repository/auth-keys.js'

import { SqliteStorageDriver } from '../driver.js'

interface AuthKeyDto {
    dc: number
    key: Uint8Array
}

interface TempAuthKeyDto extends AuthKeyDto {
    expires?: number
    idx?: number
}

export class SqliteAuthKeysRepository implements IAuthKeysRepository {
    constructor(readonly _driver: SqliteStorageDriver) {
        _driver.registerMigration('auth_keys', 1, (db) => {
            db.exec(`
                create table auth_keys (
                    dc integer primary key,
                    key blob not null
                );
                create table temp_auth_keys (
                    dc integer not null,
                    idx integer not null,
                    key blob not null,
                    expires integer not null,
                    primary key (dc, idx)
                );
            `)
        })
        _driver.onLoad((db) => {
            this._get = db.prepare('select key from auth_keys where dc = ?')
            this._getTemp = db.prepare('select key from temp_auth_keys where dc = ? and idx = ? and expires > ?')

            this._set = db.prepare('insert or replace into auth_keys (dc, key) values (?, ?)')
            this._setTemp = this._driver.db.prepare('insert or replace into temp_auth_keys (dc, idx, key, expires) values (?, ?, ?, ?)')

            this._del = db.prepare('delete from auth_keys where dc = ?')
            this._delTemp = db.prepare('delete from temp_auth_keys where dc = ? and idx = ?')
            this._delTempAll = db.prepare('delete from temp_auth_keys where dc = ?')
            this._delAll = db.prepare('delete from auth_keys')
        })
    }

    private _set!: Statement
    private _del!: Statement
    set(dc: number, key: Uint8Array | null): void {
        if (!key) {
            this._del.run(dc)

            return
        }

        this._set.run(dc, key)
    }

    private _get!: Statement
    get(dc: number): Uint8Array | null {
        const row = this._get.get(dc)
        if (!row) return null

        return (row as AuthKeyDto).key
    }

    private _setTemp!: Statement
    private _delTemp!: Statement
    setTemp(dc: number, idx: number, key: Uint8Array | null, expires: number): void {
        if (!key) {
            this._delTemp.run(dc, idx)

            return
        }

        this._setTemp.run(dc, idx, key, expires)
    }

    private _getTemp!: Statement
    getTemp(dc: number, idx: number, now: number): Uint8Array | null {
        const row = this._getTemp.get(dc, idx, now)
        if (!row) return null

        return (row as TempAuthKeyDto).key
    }

    private _delTempAll!: Statement
    deleteByDc(dc: number): void {
        this._del.run(dc)
        this._delTempAll.run(dc)
    }

    private _delAll!: Statement
    deleteAll(): void {
        this._delAll.run()
    }
}
