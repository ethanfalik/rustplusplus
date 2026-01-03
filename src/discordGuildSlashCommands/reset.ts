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

import * as discordjs from 'discord.js';

import { log, config, localeManager as lm, guildInstanceManager as gim } from '../../index';
import * as discordMessages from '../discordUtils/discordMessages';
import { DiscordManager } from '../managers/discordManager';
import * as types from '../utils/types';
import { Languages } from '../managers/LocaleManager';
import { GuildChannelIds, GuildInstance } from '../managers/guildInstanceManager';

const channelChoices = [
    'category',
    'settings',
    'servers',
    'information',
    'events',
    'activity',
    'teamchat',
    'commands',
    'smartSwitches',
    'smartSwitchGroups',
    'smartAlarms',
    'storageMonitors',
    'trackers',
] as const satisfies readonly (keyof GuildChannelIds)[];

export default {
    name: 'reset',

    getData(language: Languages) {
        return new discordjs.SlashCommandBuilder()
            .setName('reset')
            .setDescription(lm.getIntl(language, 'slashCommandDescRole'))
            .addSubcommand(subcommand => subcommand
                .setName('missing_channels')
                .setDescription(lm.getIntl(language, 'slashCommandDescResetMissingChannels')))
            .addSubcommand(subcommand => subcommand
                .setName('channel')
                .setDescription(lm.getIntl(language, 'slashCommandDescResetChannel'))
                .addStringOption(option => option
                    .setName('channel')
                    .setDescription(lm.getIntl(language, 'slashCommandDescResetChannelChannel'))
                    .setRequired(true)
                    .addChoices(
                        ...channelChoices.map(key => ({
                            name: key,
                            value: key,
                        })))));
    },

    async execute(dm: DiscordManager, interaction: discordjs.ChatInputCommandInteraction): Promise<boolean> {
        const fn = '[SlashCommand: reset]';
        const logParam = {
            guildId: interaction.guildId
        };

        const id = `Interaction ID: ${interaction.id} -`
        await interaction.deferReply({ flags: discordjs.MessageFlags.Ephemeral });

        if (!interaction.guild) {
            await discordMessages.sendDefaultMessage(dm, interaction, 'errorTitleUnknownError',
                'errorDescUnknownError');
            log.warn(`${fn} ${id} Unknown Error: interaction.guild is not valid.`, logParam);
            return false;
        }

        if (!dm.validPermissions(interaction, true)) {
            await discordMessages.sendDefaultMessage(dm, interaction, 'errorTitleMissingPermission',
                'errorDescMissingPermission');
            log.warn(`${fn} ${id} ${lm.getIntl(config.general.language, 'errorDescMissingPermission')}`,
                logParam);
            return false;
        }

        let result = false;
        switch (interaction.options.getSubcommand()) {
            case 'missing_channels': {
                result = await executeMissingChannels(dm, interaction);
            } break;

            case 'channel': {
                result = await executeChannel(dm, interaction);
            } break;

            default: {
                const parameters = {
                    subcommand: interaction.options.getSubcommand()
                }
                await discordMessages.sendDefaultMessage(dm, interaction, 'errorTitleInvalidSubcommand',
                    'errorDescInvalidSubcommand', parameters);
                log.warn(`${fn} ${id} ${lm.getIntl(config.general.language, 'errorDescInvalidSubcommand')}`, logParam);
                result = false;
            } break;
        }

        return result;
    }
};

async function executeMissingChannels(dm: DiscordManager, interaction: discordjs.ChatInputCommandInteraction):
    Promise<boolean> {
    const fn = '[SlashCommand: reset: missing_channels]';
    const guildId = interaction.guildId as types.GuildId;
    const logParam = {
        guildId: guildId
    };

    const id = `Interaction ID: ${interaction.id} -`

    const gInstance = gim.getGuildInstance(guildId) as GuildInstance;
    const resetChannels: string[] = [];
    for (const [channelName, channelId] of Object.entries(gInstance.guildChannelIds)) {
        if (channelId !== null) {
            const channel = await dm.getChannel(guildId, channelId as types.ChannelId)
            if (channel) {
                continue;
            }
        }

        resetChannels.push(channelName);
        await dm.setupGuildChannel(interaction.guild as discordjs.Guild, channelName as keyof GuildChannelIds, true);
        await setupChannel(dm, interaction, channelName as keyof GuildChannelIds);
    }

    const parameters = {
        channels: resetChannels.join(', ')
    };
    await discordMessages.sendDefaultMessage(dm, interaction, 'slashCommandSuccessTitleResetMissingChannels',
        'slashCommandSuccessDescResetMissingChannels', parameters);
    log.info(`${fn} ${id} ${lm.getIntl(config.general.language, 'slashCommandSuccessDescResetMissingChannels',
        parameters)}`, logParam);

    return true;
}

async function executeChannel(dm: DiscordManager, interaction: discordjs.ChatInputCommandInteraction):
    Promise<boolean> {
    const fn = '[SlashCommand: reset: channel]';
    const guildId = interaction.guildId as types.GuildId;
    const logParam = {
        guildId: guildId
    };

    const id = `Interaction ID: ${interaction.id} -`
    const channelName = interaction.options.getString('channel', true) as keyof GuildChannelIds;

    const gInstance = gim.getGuildInstance(guildId) as GuildInstance;
    if (gInstance.guildChannelIds[channelName] !== null) {
        const channelId = gInstance.guildChannelIds[channelName] as types.ChannelId;
        const channel = await dm.getChannel(guildId, channelId)
        if (channel) {
            await dm.deleteChannel(guildId, channelId);
        }

        gInstance.guildChannelIds[channelName] = null;
        gim.updateGuildInstance(guildId);
    }

    await dm.setupGuildChannel(interaction.guild as discordjs.Guild, channelName, true);
    await setupChannel(dm, interaction, channelName);

    const parameters = {
        channel: channelName
    };
    await discordMessages.sendDefaultMessage(dm, interaction, 'slashCommandSuccessTitleResetChannel',
        'slashCommandSuccessDescResetChannel', parameters);
    log.info(`${fn} ${id} ${lm.getIntl(config.general.language, 'slashCommandSuccessDescResetChannel',
        parameters)}`, logParam);

    return true;
}

async function setupChannel(dm: DiscordManager, interaction: discordjs.ChatInputCommandInteraction,
    channelName: keyof GuildChannelIds) {
    const guild = interaction.guild as discordjs.Guild;

    if (channelName === 'settings') {
        await dm.setupGuildSettingsChannel(guild, true, true);
    }
    else if (channelName === 'servers') {
        await dm.setupGuildServersChannel(guild, true, true);
    }
    //else if (channelName === 'information') {
    //	continue; // TODO! Implement information setup function
    //}
    else if (channelName === 'smartSwitches') {
        await dm.setupGuildSmartSwitchesChannel(guild, true, true);
    }
    //else if (channelName === 'smartSwitchGroups') {
    //	continue; // TODO! Implement smart switch groups setup function
    //}
    else if (channelName === 'smartAlarms') {
        await dm.setupGuildSmartAlarmsChannel(guild, true, true);
    }
    else if (channelName === 'storageMonitors') {
        await dm.setupGuildStorageMonitorsChannel(guild, true, true);
    }
    //else if (channelName === 'trackers') {
    //	continue; // TODO! Implement trackers setup function
    //}
}