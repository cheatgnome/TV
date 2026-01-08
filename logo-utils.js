const LOGO_PROXY_BASE = 'https://images.weserv.nl/';

function wrapLogoUrl(url) {
    if (!url || typeof url !== 'string') {
        return url;
    }

    if (!/^https?:\/\//i.test(url)) {
        return url;
    }

    if (url.includes('images.weserv.nl')) {
        return url;
    }

    const encodedUrl = encodeURIComponent(url);
    return `${LOGO_PROXY_BASE}?url=${encodedUrl}&w=512&h=512&fit=contain&bg=00000000`;
}

module.exports = {
    wrapLogoUrl
};
