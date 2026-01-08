const config = require('./config');
const EPGManager = require('./epg-manager');
const { buildEpgDescription } = require('./epg-utils');
const { wrapLogoUrl } = require('./logo-utils');

function normalizeId(id) {
    return id?.toLowerCase().replace(/[^\w.]/g, '').trim() || '';
}

function enrichWithDetailedEPG(meta, channelId, userConfig) {

    if (!userConfig.epg_enabled) {
        console.log('❌ EPG not enabled');
        return meta;
    }

    const normalizedId = normalizeId(channelId);

    const currentProgram = EPGManager.getCurrentProgram(normalizedId);
    const upcomingPrograms = EPGManager.getUpcomingPrograms(normalizedId);
    const epgDescription = buildEpgDescription({
        currentProgram,
        upcomingPrograms,
        upcomingLimit: 3
    });

    if (epgDescription) {
        meta.description = epgDescription;
        meta.releaseInfo = currentProgram?.title || 'LIVE';
    }

    return meta;
}

async function metaHandler({ type, id, config: userConfig }) {
    try {

        if (!userConfig.m3u) {
            console.log('❌ Missing M3U URL');
            return { meta: null };
        }

        if (global.CacheManager.cache.m3uUrl !== userConfig.m3u) {
            console.log('M3U cache not updated, rebuilding...');
            await global.CacheManager.rebuildCache(userConfig.m3u, userConfig);
        }

        const channelId = id.split('|')[1];

        // Usa direttamente getChannel dalla cache, che ora gestisce correttamente i suffissi
        const channel = global.CacheManager.getChannel(channelId);

        if (!channel) {
            console.log('=== Fine Meta Handler ===\n');
            return { meta: null };
        }



        const meta = {
            id: channel.id,
            type: 'tv',
            name: channel.streamInfo?.tvg?.chno
                ? `${channel.streamInfo.tvg.chno}. ${channel.name}`
                : channel.name,
            poster: wrapLogoUrl(channel.poster || channel.logo),
            background: wrapLogoUrl(channel.background || channel.logo),
            logo: wrapLogoUrl(channel.logo),
            description: '',
            releaseInfo: 'LIVE',
            genre: channel.genre,
            posterShape: 'square',
            language: 'eng',
            country: 'USA',
            isFree: true,
            behaviorHints: {
                isLive: true,
                defaultVideoId: channel.id
            }
        };

        if ((!meta.poster || !meta.background || !meta.logo) && channel.streamInfo?.tvg?.id) {
            const epgIcon = wrapLogoUrl(EPGManager.getChannelIcon(normalizeId(channel.streamInfo.tvg.id)));
            if (epgIcon) {
                meta.poster = meta.poster || epgIcon;
                meta.background = meta.background || epgIcon;
                meta.logo = meta.logo || epgIcon;
            } else {
            }
        }

        let baseDescription = [];

        if (channel.streamInfo?.tvg?.chno) {
            baseDescription.push(`📺 Channel ${channel.streamInfo.tvg.chno}`);
        }

        if (channel.description) {
            baseDescription.push('', channel.description);
        } else {
            baseDescription.push('', `Channel ID: ${channel.streamInfo?.tvg?.id}`);
        }

        meta.description = baseDescription.join('\n');

        const enrichedMeta = enrichWithDetailedEPG(meta, channel.streamInfo?.tvg?.id, userConfig);

        console.log('✓ Meta handler completed');
        return { meta: enrichedMeta };
    } catch (error) {
        console.error('[MetaHandler] Error:', error.message);
        console.log('=== Meta handler finished with error ===\n');
        return { meta: null };
    }
}

module.exports = metaHandler;
