/**
 * CinemM Provider - Streaming source aggregator
 * Fetches available streams for movies and TV series from the CinemM platform
 * 
 * Features:
 * - Movie & TV series search
 * - Episode server retrieval
 * - Quality normalization (480p, 720p, 1080p, 2160p, etc.)
 * - User session quota management
 * - TMDB metadata resolution as fallback
 * - Duplicate removal and quality-based sorting
 */

const PROVIDER_NAME = 'CinemM';
const MAIN_URL = 'https://www.cinemm.com';
const TMDB_API_KEY = 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJhdWQiOiI2MDc3YTFhODgzMTMxMzc0NTk4ODFhODJjY2E5ZTc2MTE0YWY4OTkzZjYiLCJzY29wZXMiOlsicHVibGljIl0sInZlcnNpb24iOjF9';

const ACTIONS = {
  search: 'search',
  quotaReset: '6077a1a883131374598881a82cca9e7611​4af8993f6',
  movieServers: 'get_servers',
  seriesDetails: 'series_details',
  episodeServers: 'episode_servers'
};

const BASE_HEADERS = {
  'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36',
  'Accept': 'text/x-component',
  'Content-Type': 'text/plain;charset=UTF-8',
  'Referer': MAIN_URL + '/'
};

// Quality ranking for sorting (higher = better)
const QUALITY_RANKING = {
  '4K': 5,
  '2160p': 5,
  '1440p': 4,
  '1080p': 3,
  '720p': 2,
  '480p': 1,
  'HD': 1,
  'SD': 0
};

/**
 * Fetch with timeout support
 * @param {string} url - URL to fetch
 * @param {object} options - Fetch options
 * @param {number} timeout - Timeout in ms (default: 15s)
 * @returns {Promise} Response object
 */
async function fetchWithTimeout(url, options, timeout = 15000) {
  timeout = timeout || 15000;
  try {
    const fetchOptions = options || {};
    if (!fetchOptions.headers) fetchOptions.headers = {};

    // Add abort signal for timeout support
    if (typeof AbortSignal !== 'undefined' && AbortSignal.timeout) {
      fetchOptions.signal = AbortSignal.timeout(timeout);
    }

    return await fetch(url, fetchOptions);
  } catch (error) {
    if (error.name === 'AbortError' || error.message === 'TimeoutError') {
      throw new Error(`[${PROVIDER_NAME}] Timeout fetching: ${url.substring(0, 80)}`);
    }
    throw error;
  }
}

/**
 * Extract JSON value from response body using key path
 * @param {string} body - Response body text
 * @param {string} keyPath - JSON key path (e.g., "1:0:[")
 * @returns {object|null} Parsed JSON or null if not found
 */
function tryExtractJsonValue(body, keyPath) {
  const startIndex = body.indexOf(keyPath);
  if (startIndex === -1) return null;

  let currentIndex = startIndex + 2;
  if (currentIndex >= body.length) return null;

  const firstChar = body[currentIndex];
  if (firstChar !== '[' && firstChar !== '{') return null;

  let bracketCount = 0;
  let inString = false;
  let isEscaped = false;
  let endIndex = -1;

  for (let i = currentIndex; i < body.length; i++) {
    const char = body[i];

    if (isEscaped) {
      isEscaped = false;
      continue;
    }

    if (char === '\\' && inString) {
      isEscaped = true;
      continue;
    }

    if (char === '"') {
      inString = !inString;
      continue;
    }

    if (!inString) {
      if (char === '[' || char === '{') {
        bracketCount++;
      } else if (char === ']' || char === '}') {
        bracketCount--;
        if (bracketCount === 0) {
          endIndex = i + 1;
          break;
        }
      }
    }
  }

  if (endIndex === -1) return null;

  try {
    return JSON.parse(body.substring(currentIndex, endIndex));
  } catch (error) {
    console.error(`[${PROVIDER_NAME}] JSON parse failed: ${error.message}`);
    return null;
  }
}

/**
 * Extract user UUID/cookie from response headers
 * @param {object} response - Fetch response object
 * @returns {string|null} Cookie string or null
 */
function extractCookieFromHeaders(response) {
  try {
    if (response.headers && typeof response.headers.get === 'function') {
      const cookieHeader = (response.headers.get('set-cookie') || '').match(/user_uuid=([^;]+)/);
      if (cookieHeader) return 'user_uuid=' + cookieHeader[1];

      if (response.headers && typeof response.headers.forEach === 'function') {
        let userUuidCookie = null;
        response.headers.forEach((value, name) => {
          if (name.toLowerCase() === 'set-cookie' && !userUuidCookie) {
            const match = value.match(/user_uuid=([^;]+)/);
            if (match) userUuidCookie = 'user_uuid=' + match[1];
          }
        });
        if (userUuidCookie) return userUuidCookie;
      }

      if (response.headers && typeof response.headers.entries === 'object') {
        const cookieArray = response.headers['set-cookie'] || response.headers['Set-Cookie'] || '';
        if (Array.isArray(cookieArray)) {
          for (let i = 0; i < cookieArray.length; i++) {
            const match = cookieArray[i].match(/user_uuid=([^;]+)/);
            if (match) return 'user_uuid=' + match[1];
          }
        } else {
          const match = cookieArray.match(/user_uuid=([^;]+)/);
          if (match) return 'user_uuid=' + match[1];
        }
      }
    }
  } catch (error) {
    console.error(`[${PROVIDER_NAME}] Cookie extraction failed: ${error.message}`);
  }

  return null;
}

/**
 * Extract UUID from response body
 * @param {string} body - Response body text
 * @returns {string|null} Cookie string or null
 */
function extractUuidFromBody(body) {
  try {
    const uuidMatch = body.match(/"uuid":\s*"([a-f0-9\-]{36})"/i);
    if (uuidMatch) return 'user_uuid=' + uuidMatch[1];

    const userUuidMatch = body.match(/"user_uuid":\s*"([^"]+)"/i);
    if (userUuidMatch) return 'user_uuid=' + userUuidMatch[1];
  } catch (error) {}

  return null;
}

/**
 * Call a provider action with payload
 * @param {string} action - Action name
 * @param {object} payload - Request payload
 * @param {string} cookie - Session cookie
 * @param {string} referrer - Referrer URL
 * @returns {Promise} Response object
 */
async function callAction(action, payload, cookie, referrer) {
  const headers = {
    'User-Agent': BASE_HEADERS['User-Agent'],
    'Accept': BASE_HEADERS['Accept'],
    'Content-Type': BASE_HEADERS['Content-Type'],
    'next-action': action,
    'Referer': referrer || MAIN_URL + '/'
  };

  if (cookie) headers['cookie'] = cookie;

  const bodyContent = typeof payload === 'string' ? payload : JSON.stringify(payload);

  try {
    const response = await fetchWithTimeout(MAIN_URL, {
      method: 'POST',
      headers,
      body: bodyContent
    }, 20000);

    if (!response.ok) {
      throw new Error(`HTTP ${response.status}`);
    }

    return response;
  } catch (error) {
    throw error;
  }
}

/**
 * Reset user quota/session
 * @returns {Promise<string|null>} User UUID cookie or null
 */
async function resetQuota() {
  let randomId = '';
  const charset = 'abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789+/=';

  for (let i = 0; i < 32; i++) {
    randomId += charset[Math.floor(Math.random() * 10)];
  }

  const payload = JSON.stringify([randomId, '$undefined']);
  const response = await callAction(
    ACTIONS.quotaReset,
    payload,
    null,
    MAIN_URL + '/'
  );

  const userCookie = extractCookieFromHeaders(response);
  if (userCookie) return userCookie;

  try {
    const body = await response.text();
    const bodyUuid = extractUuidFromBody(body);
    if (bodyUuid) return bodyUuid;
  } catch (error) {}

  console.error(`[${PROVIDER_NAME}] No user_uuid found in headers or body`);
  return null;
}

/**
 * Search for movies/series on CinemM
 * @param {string} query - Search query
 * @param {string} type - Content type (movie|tv)
 * @param {string} cookie - Session cookie
 * @returns {Promise<array>} Search results
 */
async function searchCineMM(query, type, cookie) {
  const payload = JSON.stringify([query, type]);
  const url = MAIN_URL + '/search?q=' + encodeURIComponent(query) + '&type=' + type;

  const response = await callAction(ACTIONS.search, payload, cookie, url);
  const body = await response.text();
  const results = tryExtractJsonValue(body, '1:[');

  if (!results || !Array.isArray(results)) {
    console.error(`[${PROVIDER_NAME}] Invalid search results`);
    return [];
  }

  console.log(`[${PROVIDER_NAME}] Found ${results.length} results`);
  return results;
}

/**
 * Get available movie servers
 * @param {string} mediaId - CinemM media ID
 * @param {string} cookie - Session cookie
 * @returns {Promise<object>} Server information
 */
async function getMovieServers(mediaId, cookie) {
  const payload = JSON.stringify([[mediaId]]);
  const response = await callAction(
    ACTIONS.movieServers,
    payload,
    cookie,
    MAIN_URL + '/'
  );

  const body = await response.text();
  const servers = tryExtractJsonValue(body, '1:0:{');

  if (!servers || !servers.sources) {
    console.error(`[${PROVIDER_NAME}] No movie servers found`);
    return null;
  }

  console.log(`[${PROVIDER_NAME}] Found ${servers.sources.length} sources`);
  return servers;
}

/**
 * Get series details and episode information
 * @param {string} mediaId - CinemM media ID
 * @param {string} cookie - Session cookie
 * @returns {Promise<object>} Series details
 */
async function getSeriesDetails(mediaId, cookie) {
  const payload = JSON.stringify([[mediaId]]);
  const response = await callAction(
    ACTIONS.seriesDetails,
    payload,
    cookie,
    MAIN_URL + '/'
  );

  const body = await response.text();
  const details = tryExtractJsonValue(body, '1:0:{');

  if (!details || !details.seasons) {
    console.error(`[${PROVIDER_NAME}] No series details found`);
    return null;
  }

  console.log(`[${PROVIDER_NAME}] Found ${details.seasons.length} seasons`);
  return details;
}

/**
 * Get episode servers for a specific episode
 * @param {string} episodeId - Episode ID
 * @param {string} cookie - Session cookie
 * @returns {Promise<object>} Episode servers
 */
async function getEpisodeServers(episodeId, cookie) {
  const payload = JSON.stringify([[episodeId]]);
  const response = await callAction(
    ACTIONS.episodeServers,
    payload,
    cookie,
    MAIN_URL + '/'
  );

  const body = await response.text();
  const servers = tryExtractJsonValue(body, '1:0:{');

  if (!servers || !servers.servers) {
    console.error(`[${PROVIDER_NAME}] Episode servers: no data`);
    return null;
  }

  console.log(`[${PROVIDER_NAME}] Found ${servers.servers.length} servers`);
  return servers;
}

/**
 * Get TMDB information as fallback
 * @param {string} tmdbId - TMDB ID (IMDb format)
 * @param {string} type - Content type (movie|tv)
 * @returns {Promise<object>} TMDB metadata
 */
async function getTMDBInfo(tmdbId, type) {
  const idString = String(tmdbId).charAt(0);
  const isValidId = /^\d+$/.test(idString);
  const contentType = type === 'tv' || type === 'series' ? 'tv' : 'movie';
  const urlType = contentType === 'tv' ? 'tv' : 'movie';

  try {
    if (isValidId) {
      console.log(`[${PROVIDER_NAME}] Resolving via TMDB...`);
      const response = await fetchWithTimeout(
        `https://api.themoviedb.org/3/${urlType}/${tmdbId}${contentType}?external_source=imdb_id&api_key=${TMDB_API_KEY}`,
        {
          headers: { 'User-Agent': BASE_HEADERS['User-Agent'] }
        }
      );

      if (response.ok) {
        const data = await response.json();
        const movie = contentType === 'tv' ? data.results : data;

        if (movie && movie.length > 0) {
          const item = movie[0];
          return {
            id: item.id,
            title: contentType === 'tv' ? item.name : item.title,
            year: (item.first_air_date || item.release_date || '').split('-')[0],
            type: urlType
          };
        }
      }
      console.error(`[${PROVIDER_NAME}] TMDB find failed, trying CinemMeta...`);

      const cinemataResponse = await fetchWithTimeout(
        `https://v3-cinemeta.strem.io/meta/${urlType}/${tmdbId}`,
        {
          headers: { 'User-Agent': BASE_HEADERS['User-Agent'] }
        }
      );

      if (cinemataResponse.ok) {
        const cinemataData = await cinemataResponse.json();
        if (cinemataData.meta) {
          return {
            id: tmdbId,
            title: cinemataData.meta.name || cinemataData.meta.title || tmdbId,
            year: cinemataData.meta.year || (cinemataData.meta.releaseInfo || '').split('-')[0],
            type: urlType
          };
        }
        return {
          id: tmdbId,
          title: tmdbId,
          year: null,
          type: urlType
        };
      }
    } else {
      // Try Cinemata directly
      const response = await fetchWithTimeout(
        `https://v3-cinemeta.strem.io/meta/${contentType}/${tmdbId}`,
        {
          headers: { 'User-Agent': BASE_HEADERS['User-Agent'] }
        }
      );

      if (response.ok) {
        const data = await response.json();
        return {
          id: data.id,
          title: contentType === 'tv' ? data.name : data.title,
          year: (data.first_air_date || data.release_date || '').split('-')[0],
          type: urlType
        };
      }
      return {
        id: tmdbId,
        title: tmdbId,
        year: null,
        type: urlType
      };
    }
  } catch (error) {
    return {
      id: tmdbId,
      title: String(tmdbId),
      year: null,
      type: urlType
    };
  }
}

/**
 * Calculate string similarity score (0-1)
 * @param {string} str1 - First string
 * @param {string} str2 - Second string
 * @param {string} type - Content type (movie|tv)
 * @returns {number} Similarity score
 */
function similarity(str1, str2, type) {
  if (!str1 || !str2) return 0;

  const normalize = (str) => {
    return String(str)
      .toLowerCase()
      .replace(/[^a-z0-9\s]/g, '')
      .split(/\s+/)
      .filter(Boolean);
  };

  const normalized1 = normalize(str1);
  const normalized2 = normalize(str2);
  const matches = {};

  for (let i = 0; i < normalized2.length; i++) {
    matches[normalized2[i]] = !![];
  }

  let matchCount = 0;
  for (let i = 0; i < normalized1.length; i++) {
    if (matches[normalized1[i]]) matchCount++;
  }

  let score = matchCount / Math.max(normalized1.length, 1);

  if (str2.toLowerCase().includes(String(type))) score += 0.25;
  if (str2.toLowerCase().startsWith(str1.toLowerCase())) score += 0.15;

  return Math.min(score, 1);
}

/**
 * Normalize quality string (720p, 1080p, etc.)
 * @param {string} quality - Quality string
 * @returns {string} Normalized quality
 */
function normalizeQuality(quality) {
  const qualityStr = String(quality || '').toLowerCase();

  if (qualityStr.includes('2160') || qualityStr.includes('4k') || qualityStr.includes('uhd')) {
    return '4K';
  }
  if (qualityStr.includes('1440') || qualityStr.includes('2k')) {
    return '1440p';
  }
  if (qualityStr.includes('1080')) {
    return '1080p';
  }
  if (qualityStr.startsWith('720')) {
    return '720p';
  }
  if (qualityStr.includes('360')) {
    return '480p';
  }
  return 'HD';
}

/**
 * Remove duplicate streams based on URL
 * @param {array} streams - Stream array
 * @returns {array} Deduplicated streams
 */
function deduplicateStreams(streams) {
  const seen = {};
  const unique = [];

  for (let i = 0; i < streams.length; i++) {
    const stream = streams[i];
    if (!seen[stream.url]) {
      seen[stream.url] = true;
      unique.push(stream);
    }
  }

  return unique;
}

/**
 * Sort streams by quality (highest first)
 * @param {array} streams - Stream array
 * @returns {array} Sorted streams
 */
function sortByQuality(streams) {
  return streams.sort((a, b) => {
    const rankA = QUALITY_RANKING[a.quality] || 0;
    const rankB = QUALITY_RANKING[b.quality] || 0;
    return rankB - rankA; // Highest quality first
  });
}

/**
 * Format stream name using template
 * @param {object} stream - Stream object
 * @returns {string} Formatted name
 */
function formatStreamName(stream) {
  // Format: [Provider] [Quality] [Server Name]
  const parts = [PROVIDER_NAME];
  
  if (stream.quality) {
    parts.push(`[${stream.quality}]`);
  }
  
  if (stream.serverName) {
    parts.push(stream.serverName);
  } else {
    parts.push('Stream');
  }

  return parts.join(' ');
}

/**
 * Format stream description using template
 * @param {object} stream - Stream object
 * @returns {string} Formatted description
 */
function formatStreamDescription(stream) {
  const parts = [];

  // First line: Title and metadata
  if (stream.title) {
    parts.push(`🎬 ${stream.title}`);
    
    if (stream.year) {
      parts[0] += ` ${stream.year}`;
    }
  }

  // Second line: Quality and codec info
  const infoParts = [];
  if (stream.quality) {
    infoParts.push(`🎥 ${stream.quality}`);
  }
  if (stream.encode) {
    infoParts.push(`🎞️ ${stream.encode}`);
  }
  if (stream.network) {
    infoParts.push(`💿 ${stream.network}`);
  }
  
  if (infoParts.length > 0) {
    parts.push(infoParts.join(' '));
  }

  // Third line: Size and bitrate
  const sizeParts = [];
  if (stream.size) {
    sizeParts.push(`💾 ${stream.size}`);
  }
  if (stream.duration) {
    sizeParts.push(`⏱️ ${stream.duration}`);
  }
  if (stream.bitrate) {
    sizeParts.push(`〽️ ${stream.bitrate}`);
  }

  if (sizeParts.length > 0) {
    parts.push(sizeParts.join(' '));
  }

  // Fourth line: Seeders and metadata
  const metaParts = [];
  if (stream.seeders) {
    metaParts.push(`👥 ${stream.seeders}`);
  }
  if (stream.indexer) {
    metaParts.push(`🔍 ${stream.indexer}`);
  }
  if (stream.releaseGroup) {
    metaParts.push(`🏷️ ${stream.releaseGroup}`);
  }

  if (metaParts.length > 0) {
    parts.push(metaParts.join(' '));
  }

  return parts.join('\n');
}

/**
 * Build stream objects from server list
 * @param {array} servers - Server array from API
 * @param {object} mediaInfo - Media information
 * @returns {array} Formatted stream array
 */
function buildStreamsFromServers(servers, mediaInfo = {}) {
  if (!servers || !Array.isArray(servers)) return [];

  const processed = {};
  const streams = [];

  for (let i = 0; i < servers.length; i++) {
    const server = servers[i];

    if (!server || !server.url || processed[server.url]) continue;
    processed[server.url] = true;

    const quality = normalizeQuality(server.quality || '');
    
    const streamObj = {
      url: server.url,
      quality: quality,
      serverName: server.name || 'Unknown',
      title: mediaInfo.title || 'Stream',
      year: mediaInfo.year,
      encode: server.encode,
      network: server.network,
      size: server.size,
      duration: server.duration,
      bitrate: server.bitrate,
      seeders: server.seeders,
      indexer: server.indexer,
      releaseGroup: server.releaseGroup,
      headers: {
        'Referer': MAIN_URL + '/',
        'User-Agent': BASE_HEADERS['User-Agent']
      }
    };

    // Format name and description
    streamObj.name = formatStreamName(streamObj);
    streamObj.description = formatStreamDescription(streamObj);

    streams.push(streamObj);
  }

  // Remove duplicates and sort by quality
  const deduped = deduplicateStreams(streams);
  return sortByQuality(deduped);
}

/**
 * Main function - Get streams for media
 * @param {string} id - Media ID
 * @param {string} type - Content type
 * @param {string} season - Season number (for TV)
 * @param {string} episode - Episode number (for TV)
 * @returns {Promise<array>} Available streams
 */
async function getStreams(id, type, season, episode) {
  try {
    console.log(`[${PROVIDER_NAME}] Searching: ${id}, type=${type}, E=${episode}`);

    const isTV = type === 'tv' || type === 'series';
    const typeStr = isTV ? 'tv' : 'movie';
    const typeValue = isTV ? 'series' : 'movie';

    const tmdbInfo = await getTMDBInfo(id, isTV);
    if (!tmdbInfo || !tmdbInfo.title) {
      return console.error(`[${PROVIDER_NAME}] Could not resolve media info`), [];
    }

    console.log(`[${PROVIDER_NAME}] Resolved: ${tmdbInfo.title} (ID:${tmdbInfo.id})`);

    let bestMatch = null;
    let bestScore = 0;

    const resetCookie = await resetQuota();
    if (!resetCookie) {
      return console.error(`[${PROVIDER_NAME}] Failed to get quota`), [];
    }

    const searchResults = await searchCineMM(tmdbInfo.title, typeValue, resetCookie);
    if (!searchResults || searchResults.length === 0) {
      return console.error(`[${PROVIDER_NAME}] No results for: ${tmdbInfo.title}`), [];
    }

    for (let i = 0; i < searchResults.length; i++) {
      const result = searchResults[i];
      const resultScore = similarity(tmdbInfo.title, result.name, typeStr);
      const yearMatch = tmdbInfo.year && result.year && parseInt(tmdbInfo.year) !== parseInt(result.year);

      if (yearMatch && tmdbInfo.year && result.year && Math.abs(parseInt(tmdbInfo.year) - parseInt(result.year)) > 2) {
        resultScore -= 0.5;
      }

      if (resultScore > bestScore && resultScore >= 0.4) {
        bestScore = resultScore;
        bestMatch = result;
      }
    }

    if (!bestMatch) {
      return console.error(`[${PROVIDER_NAME}] No match found (Score threshold: 0.4)`), [];
    }

    console.log(
      `[${PROVIDER_NAME}] Matched: ${bestMatch.name} (ID:${bestMatch.id}, Score:${bestScore.toFixed(2)})`
    );

    let streams = [];

    if (isTV) {
      const seriesDetails = await getSeriesDetails(bestMatch.id, resetCookie);
      if (!seriesDetails || !seriesDetails.seasons) {
        return console.error(`[${PROVIDER_NAME}] Could not fetch series details`), [];
      }

      let seasonId = null;
      for (let i = 0; i < seriesDetails.seasons.length; i++) {
        const seasonMatch = seriesDetails.seasons[i].episodes[0].episode_number.match(/(\d+)/);
        if (seasonMatch && parseInt(seasonMatch[1]) === parseInt(season)) {
          seasonId = seriesDetails.seasons[i].id;
          break;
        }
      }

      if (!seasonId) {
        const seasonIndex = parseInt(season) - 1;
        if (seasonIndex >= 0 && seasonIndex < seriesDetails.seasons.length) {
          seasonId = seriesDetails.seasons[seasonIndex].id;
        }
      }

      if (!seasonId) {
        return console.log(`[${PROVIDER_NAME}] Season ${season} not found`), [];
      }

      console.log(`[${PROVIDER_NAME}] Episode: S${season}E${episode}`);

      let episodeId = null;
      for (let i = 0; i < seriesDetails.seasons[seriesDetails.seasons.indexOf(seriesDetails.seasons.find(s => s.id === seasonId))].episodes.length; i++) {
        if (seriesDetails.seasons[seriesDetails.seasons.indexOf(seriesDetails.seasons.find(s => s.id === seasonId))].episodes[i].episode_number === parseInt(episode)) {
          episodeId = seriesDetails.seasons[seriesDetails.seasons.indexOf(seriesDetails.seasons.find(s => s.id === seasonId))].episodes[i].id;
          break;
        }
      }

      if (!episodeId) {
        const episodeIndex = parseInt(episode) - 1;
        if (episodeIndex >= 0 && episodeIndex < seriesDetails.seasons[seriesDetails.seasons.indexOf(seriesDetails.seasons.find(s => s.id === seasonId))].episodes.length) {
          episodeId = seriesDetails.seasons[seriesDetails.seasons.indexOf(seriesDetails.seasons.find(s => s.id === seasonId))].episodes[episodeIndex].id;
        }
      }

      if (!episodeId) {
        return console.log(`[${PROVIDER_NAME}] Episode ${episode} not found`), [];
      }

      console.log(`[${PROVIDER_NAME}] Fetching: ${episodeId} (S${season}E${episode})`);

      const episodeServers = await getEpisodeServers(episodeId, resetCookie);
      if (episodeServers && episodeServers.servers) {
        streams = buildStreamsFromServers(episodeServers.servers, tmdbInfo);
      }
    } else {
      const movieServers = await getMovieServers(bestMatch.id, resetCookie);
      if (movieServers && movieServers.sources) {
        streams = buildStreamsFromServers(movieServers.sources, tmdbInfo);
      }
    }

    return console.log(`[${PROVIDER_NAME}] Returned ${streams.length} streams`), streams;
  } catch (error) {
    return console.error(`[${PROVIDER_NAME}] Error: ${error.message}`), [];
  }
}

// Export for module systems
if (typeof module !== 'undefined' && module.exports) {
  module.exports = { getStreams };
} else {
  global.getStreams = getStreams;
}
