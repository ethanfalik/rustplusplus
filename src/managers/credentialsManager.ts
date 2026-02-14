/*
    Copyright (C) 2025 Alexander Emanuelsson (alexemanuelol)

    This program is free software: you can redistribute it and/or modify
    it under the terms of the GNU General Public License as published by
    the Free Software Foundation, either version 3 of the License, or
    (at your option) any later version.

    This program is distributed in the hope that it will be useful,
    but WITHOUT ANY WARRANTY; without even the implied warranty of
    MERCHANTABILITY or FITNESS FOR A PARTICULAR PURPOSE.  See the
    GNU General Public License for more details.

    You should have received a copy of the GNU General Public License
    along with this program.  If not, see <https://www.gnu.org/licenses/>.

    https://github.com/alexemanuelol/rustplusplus

*/

import * as fs from 'fs';
import * as path from 'path';
import { Prisma, Credential, Gcm } from '../../generated/prisma/client';

import { log, prisma } from '../../index';
import * as types from '../utils/types';
import * as vu from '../utils/validationUtils';
import { DiscordManager } from './discordManager';
import { sendCredentialsExpiredMessage } from '../discordUtils/discordMessages';

export type TCredential = Prisma.CredentialGetPayload<{
    include: { gcm: true };
}>;

export type TCredentialInput =
    Omit<Credential, 'id' | 'gcmId'> &
    Omit<Gcm, 'id'>;


export const VERSION = 1;

export enum ReadError {
    NotFound = 0,
    ReadFailed = 1,
    ParseFailed = 2,
    InvalidVersion = 3,
    InvalidFormat = 4
}

export enum WriteError {
    NoError = 0,
    InvalidFormat = 1,
    InvalidVersion = 2,
    WriteFailed = 3
}

export type CredentialsMap = { [steamId: types.SteamId]: Credentials };

export interface Credentials {
    version: number;
    steamId: types.SteamId;
    gcm: Gcm;
    discordUserId: types.UserId;
    issueDate: types.Timestamp;
    expireDate: types.Timestamp;
    expirationNotified: boolean;
}


export type DiscordUserIdToSteamIdsMap = {
    [discordUserId: types.UserId]: types.SteamId[];
};

export class CredentialsManager {
    private expirationTimeoutIds: Map<types.SteamId, NodeJS.Timeout>;

    constructor() {
        const fn = '[CredentialsManager: Init]';
        log.info(`${fn}.`);

        this.expirationTimeoutIds = new Map();
    }

    public async getCredentials(steamId: types.SteamId): Promise<TCredential | null> {
        return prisma.credential.findUnique({
            where: { steamId },
            include: { gcm: true },
        });
    }

    public async setCredentials(data: TCredentialInput): Promise<TCredential> {
        return prisma.credential.upsert({
            where: {
                steamId: data.steamId
            },
            create: {
                steamId: data.steamId,
                discordUserId: data.discordUserId,
                issueDate: data.issueDate,
                expireDate: data.expireDate,
                expirationNotified: data.expirationNotified,
                gcm: {
                    create: {
                        androidId: data.androidId,
                        securityToken: data.securityToken,
                    }
                }
            },
            update: {
                discordUserId: data.discordUserId,
                issueDate: data.issueDate,
                expireDate: data.expireDate,
                expirationNotified: data.expirationNotified,
                gcm: {
                    update: {
                        androidId: data.androidId,
                        securityToken: data.securityToken,
                    }
                }
            },
            include: { gcm: true }
        });
    }




    private async handleExpiredCredentials(steamId: types.SteamId, dm: DiscordManager) {
        const credentials = this.getCredentials(steamId);
        if (credentials === null) return;

        const currentTimestamp = Math.floor(Date.now() / 1000);
        if (credentials.expireDate < currentTimestamp && !credentials.expirationNotified) {
            await sendCredentialsExpiredMessage(dm, steamId);
            credentials.expirationNotified = true;
            this.updateCredentials(steamId);
        }

        this.cancelExpireTimeout(steamId);
    }

    public getCredentialSteamIds(): types.SteamId[] {
        return Object.keys(this.credentialsMap);
    }

    public getDiscordUserIdToSteamIdsMap(): DiscordUserIdToSteamIdsMap {
        const steamIds = this.getCredentialSteamIds();
        const map: DiscordUserIdToSteamIdsMap = {};
        for (const steamId of steamIds) {
            const credentials = this.getCredentialsDeepCopy(steamId) as Credentials;
            if (Object.hasOwn(map, credentials.discordUserId)) {
                map[credentials.discordUserId].push(steamId);
            }
            else {
                map[credentials.discordUserId] = [steamId];
            }
        }

        return map;
    }

    public getCredentialSteamIdsFromDiscordUserId(discordUserId: types.UserId): types.SteamId[] {
        const steamIds: types.SteamId[] = [];

        for (const [steamId, credentials] of Object.entries(this.credentialsMap)) {
            if (credentials.discordUserId === discordUserId) {
                steamIds.push(steamId);
            }
        }

        return steamIds;
    }

    public getCredentialsDeepCopy(steamId: types.SteamId): Credentials | null {
        const credentials = this.credentialsMap[steamId];
        return credentials ? structuredClone(credentials) : null;
    }

    public updateCredentials(steamId: types.SteamId): boolean {
        const fn = `[CredentialsManager: updateCredentials: ${steamId}]`;

        const credentials = this.credentialsMap[steamId];
        if (!credentials) {
            log.warn(`${fn} Credentials could not be found.`);
            return false;
        }

        const result = this.writeCredentialsFile(steamId, credentials);
        if (result !== WriteError.NoError) {
            log.warn(`${fn} Failed to update Credentials file.`);
            return false;
        }

        return true;
    }

    public deleteCredentials(steamId: types.SteamId): boolean {
        this.cancelExpireTimeout(steamId);

        const result = this.deleteCredentialsFile(steamId);
        if (result) {
            delete this.credentialsMap[steamId];
            return true;
        }
        return false;
    }

    public addCredentials(steamId: types.SteamId, credentials: Credentials): boolean {
        const fn = `[CredentialsManager: addCredentials: ${steamId}]`;

        if (steamId in this.credentialsMap) {
            log.warn(`${fn} Old Credentials will be overwritten.`);
        }

        const result = this.writeCredentialsFile(steamId, credentials);
        if (result !== WriteError.NoError) {
            log.warn(`${fn} Failed to write Credentials to file.`);
            return false;
        }

        this.credentialsMap[steamId] = credentials;

        return true;
    }

    public scheduleExpireTimeout(steamId: types.SteamId, dm: DiscordManager) {
        const fn = `[CredentialsManager: scheduleExpireTimeout: ${steamId}]`;

        if (this.expirationTimeoutIds.has(steamId)) {
            /* Ensure no duplicate timeouts exist. */
            this.cancelExpireTimeout(steamId);
        }

        const credentials = this.getCredentials(steamId);
        if (credentials === null) return;

        const currentTimestamp = Math.floor(Date.now() / 1000);
        const timeoutBufferMs = 5000; /* 5 seconds buffer to ensure the timeout triggers after expiration. */
        const timeoutMs = ((credentials.expireDate - currentTimestamp) * 1000) + timeoutBufferMs;

        if (timeoutMs <= 0) {
            this.handleExpiredCredentials(steamId, dm);
            return;
        }

        const timeoutId = setTimeout(() => {
            this.handleExpiredCredentials(steamId, dm);
        }, timeoutMs);

        this.expirationTimeoutIds.set(steamId, timeoutId);
        log.info(`${fn} Expires in ${timeoutMs / 1000} seconds.`);
    }

    public cancelExpireTimeout(steamId: types.SteamId) {
        const fn = `[CredentialsManager: cancelExpireTimeout: ${steamId}]`;

        const timeoutId = this.expirationTimeoutIds.get(steamId);
        if (timeoutId) {
            clearTimeout(timeoutId);
            this.expirationTimeoutIds.delete(steamId);
        }
        log.info(`${fn} Expire timeout deleted.`);
    }
}