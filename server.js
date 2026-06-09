const crypto = require( 'crypto' );
const sha1 = require( 'sha1' );
const restify = require( 'restify' );
const passport = require( 'passport' );
const alphanumSort = require( 'alphanum-sort' );
const Hashids = require( 'hashids/cjs' );
const Strategy = require( 'passport-http-bearer' ).Strategy;
const corsMiddleware = require( 'restify-cors-middleware2' );
const { Op } = require('sequelize');
const { LRUCache } = require( 'lru-cache' );

const models = require( './models' );

const LISTEN_PORT = process.env.PORT || 3000;
const JSON_INDENTATION = 4;
const SUCCESS_STATUS_CODE = 200;
const INTERNAL_SERVER_ERROR_STATUS_CODE = 500;
const MALFORMED_REQUEST_STATUS_CODE = 400;
const FORBIDDEN_STATUS_CODE = 403;
const NOT_FOUND_STATUS_CODE = 404;
const SERVICE_UNAVAILABLE_STATUS_CODE = 503;
const TOKEN_REFRESH_INTERVAL = 60 * 1000;
const TOKEN_LENGTH = 24;
const EXISTING_RESOURCE_STATUS_CODE = 409;
const ID_HASH_MIN_LENGTH = 8;
const MAX_POST_LIMIT = 1000;
const MAX_POST_OFFSET = 10000;
const DEFAULT_POST_LIMIT = 50;
const CACHE_TIMES = {
    favicon: 2592000,
    groups: 3600,
    posts: 900,
    services: 3600,
    singlePost: 2592000,
    singlePostHead: 600,
    stats: 300,
};

const STATS_WINDOW_DAYS = 30;
const STATS_QUARTER_DAYS = 90;
const STATS_WEEK_DAYS = 7;
const SECONDS_PER_DAY = 86400;
const MILLISECONDS_PER_SECOND = 1000;

const hashids = new Hashids( '', ID_HASH_MIN_LENGTH, 'abcdefghijklmnopqrstuvwxyz' );

const server = restify.createServer( {
    // eslint-disable-next-line no-sync
    // certificate: fs.readFileSync( path.join( __dirname, './assets/fullchain.pem' ) ),
    // eslint-disable-next-line no-sync
    // key: fs.readFileSync( path.join( __dirname, './assets/privkey.pem' ) ),
    name: 'Post tracker REST API',
} );

// Tokens live in the `tokens` DB table (name + scopes per token). They're
// cached in memory so auth doesn't hit the DB on every request; the cache is
// refreshed periodically and busted immediately when tokens are created/revoked.
const tokenScopes = new Map();

// Optional break-glass token: always authenticates with admin scope and is
// never stored in the DB, so an empty/unreachable tokens table can't lock
// everyone out (recovery / first boot).
const ROOT_API_TOKEN = process.env.ROOT_API_TOKEN;

// Transitional fallback for the pre-DB env-var token registry. A token that
// isn't in the DB (or the ROOT break-glass) is authorized against its old
// per-path/method permissions from API_TOKENS, exactly as before — so existing
// tokens keep working across the deploy with no service interruption. Once all
// tokens are seeded into the `tokens` table, remove API_TOKENS from the env and
// this fallback goes dormant.
const legacyTokenData = process.env.API_TOKENS ? JSON.parse( process.env.API_TOKENS ) : {};

const legacyAuthorize = function legacyAuthorize ( token, routePath, method ) {
    const entry = legacyTokenData[ token ];

    if ( !entry || !entry.paths || !entry.paths[ routePath ] ) {
        return false;
    }

    return entry.paths[ routePath ].includes( method );
};

const loadTokens = async function loadTokens () {
    const tokens = await models.Token.findAll( {
        where: {
            active: true,
        },
    } );

    tokenScopes.clear();

    tokens.forEach( ( tokenRow ) => {
        tokenScopes.set( tokenRow.token, {
            name: tokenRow.name,
            scopes: tokenRow.scopes || [],
        } );
    } );
};

const lookupToken = function lookupToken ( token ) {
    if ( ROOT_API_TOKEN && token === ROOT_API_TOKEN ) {
        return {
            name: 'root',
            scopes: [ 'admin' ],
        };
    }

    const found = tokenScopes.get( token );

    if ( found ) {
        return found;
    }

    // Not yet migrated to the DB — recognise it so passport authenticates it;
    // requireScope/the GET /games check then fall back to its legacy per-path
    // permissions instead of scopes.
    if ( legacyTokenData[ token ] ) {
        return {
            legacy: true,
            name: 'legacy',
            scopes: [],
        };
    }

    return false;
};

const generateToken = function generateToken () {
    let token = '';

    while ( token.length < TOKEN_LENGTH ) {
        token += crypto.randomBytes( TOKEN_LENGTH ).toString( 'base64' ).replace( /[^a-zA-Z0-9]/g, '' );
    }

    return token.slice( 0, TOKEN_LENGTH );
};

const myCache = new LRUCache( {
    max: 1000,
    maxSize: 800 * 1024 * 1024,
    sizeCalculation: ( value ) => {
        return value.length;
    },
    ttl: CACHE_TIMES.posts * 1000,
} );

passport.use( new Strategy(
    ( token, authenticationCallback ) => {
        const found = lookupToken( token );

        if ( !found ) {
            return authenticationCallback( null, false );
        }

        return authenticationCallback( null, {
            legacy: found.legacy || false,
            name: found.name,
            scopes: found.scopes,
            token: token,
        } );
    }
) );

// Route guard factory: authenticates the bearer token, then requires the token
// to carry the given scope (the `admin` scope satisfies any requirement).
const requireScope = function requireScope ( scope ) {
    return [
        passport.authenticate( 'bearer', {
            session: false,
        } ),
        ( request, response, next ) => {
            const user = request.user || {};

            // Legacy env-var tokens authorize against their old per-path map
            // rather than scopes, preserving their exact prior access.
            if ( user.legacy ) {
                if ( legacyAuthorize( user.token, request.route.path, request.method ) ) {
                    return next();
                }
            } else {
                const scopes = user.scopes || [];

                if ( scopes.includes( 'admin' ) || scopes.includes( scope ) ) {
                    return next();
                }
            }

            response.send( FORBIDDEN_STATUS_CODE, {
                error: 'Insufficient scope',
                required: scope,
            } );

            return false;
        },
    ];
};

const cors = corsMiddleware( {
    allowHeaders: [ 'authorization' ],
    exposeHeaders: [ 'authorization' ],
    origins: [ '*' ],
} );

const addHeader = ( request, response, next ) => {
    response.setHeader( 'vary', 'accept-encoding' );
    next();
};

const accessLog = ( request, response, next ) => {
    const startNs = process.hrtime.bigint();
    const clientIp = request.headers[ 'cf-connecting-ip' ]
        || ( request.headers[ 'x-forwarded-for' ] || '' ).split( ',' )[ 0 ].trim()
        || ( request.connection && request.connection.remoteAddress )
        || '-';
    const userAgent = request.headers[ 'user-agent' ] || '-';

    console.log( `[access:start] ${ new Date().toISOString() } ${ clientIp } "${ request.method } ${ request.url }" "${ userAgent }"` );

    response.on( 'finish', () => {
        const durationMs = Number( process.hrtime.bigint() - startNs ) / 1e6;
        console.log( `[access] ${ new Date().toISOString() } ${ clientIp } "${ request.method } ${ request.url }" ${ response.statusCode } ${ durationMs.toFixed( 1 ) }ms "${ userAgent }"` );
    } );

    next();
};

server.pre( cors.preflight );
server.use( cors.actual );
server.use( restify.plugins.bodyParser() );
server.use( restify.plugins.queryParser() );
server.use( restify.plugins.gzipResponse() );
server.use( addHeader );
server.use( accessLog );

// Prime the token cache and keep it fresh so newly issued / revoked tokens
// propagate without a restart.
loadTokens().catch( ( loadError ) => {
    console.error( 'Failed to load tokens', loadError );
} );
setInterval( () => {
    loadTokens().catch( ( loadError ) => {
        console.error( 'Failed to refresh tokens', loadError );
    } );
}, TOKEN_REFRESH_INTERVAL );

const postsCache = new LRUCache( {
    max: 50000,
    ttl: CACHE_TIMES.singlePost * 1000,
} );
let allAccounts = [];

const CACHE_QUERY_KEYS = [
    'search',
    'services',
    'groups',
    'excludeService',
    'limit',
    'offset',
];

const getCacheKey = ( request ) => {
    const params = new URLSearchParams();

    for ( const key of CACHE_QUERY_KEYS ) {
        const value = request.query[ key ];

        if ( value === undefined || value === null || value === '' ) {
            continue;
        }

        if ( Array.isArray( value ) ) {
            params.append( key, value.join( ',' ) );
        } else {
            params.append( key, String( value ) );
        }
    }

    params.sort();

    const queryString = params.toString();
    const base = `${ request.params.game }/posts`;

    return queryString ? `${ base }?${ queryString }` : base;
};

const getAllAccounts = async () => {
    const query = {
        attributes: [
            'id',
            'identifier',
            'service',
        ],
        include: [
            {
                attributes: [
                    'group',
                    'name',
                    'nick',
                    'role',
                    'active',
                ],
                include: [
                    {
                        attributes: [
                            'identifier',
                        ],
                        model: models.Game,
                    },
                ],
                model: models.Developer,
            },
        ],
    };

    await models.Account.findAll( query )
        .then( ( accountInstances ) => {
            const newAccounts = [];
            for ( let i = 0; i < accountInstances.length; i = i + 1 ) {
                const account = accountInstances[ i ].get();

                newAccounts.push(account);
            }

            allAccounts = newAccounts;
        } )
        .catch( ( findError ) => {
            // Background refresh (startup + 60s interval). A transient DB pool
            // timeout here must not reject (it would become an unhandled
            // rejection); just log and keep the previously cached accounts.
            console.error( `[warn] getAllAccounts refresh failed, keeping cached accounts: ${ findError.message }` );
        } );
};

getAllAccounts();
setInterval(getAllAccounts, 60000);

const getAccountsForGame = async (gameIdentifier) => {
    const gameAccounts = allAccounts.filter((account) => {
        return account.developer.game.identifier === gameIdentifier;
    });

    return gameAccounts;
};

// Anything with a dot basically
const serveStatic = restify.plugins.serveStatic( {
    default: 'index.json',
    directory: './static',
} );

// restify's find-my-way router (v7+) dropped RegExp route paths, so this
// static-file catch-all is now a '/*' wildcard. find-my-way gives wildcards
// the lowest match precedence, so the API/:param routes still win and only
// otherwise-unmatched paths (asset requests) fall through to serveStatic.
server.get( '/*', ( request, response, next ) => {
    try {
        decodeURIComponent( request.path() );
    } catch ( decodeError ) {
        response.status( MALFORMED_REQUEST_STATUS_CODE );
        response.end();

        return next( false );
    }

    return serveStatic( request, response, next );
} );

server.get( '/', ( request, response, next ) => {
    response.json( 'Wanna do cool stuff? Msg me wherever /u/Kokarn kokarn@gmail @oskarrisberg' );
} );

server.get( '/health', ( request, response, next ) => {
    response.json( { status: 'ok' } );
} );

server.get( '/loaderio-7fa45b57bc0a2a51cd5159425752f4f2/', ( request, response, next ) => {
    response.sendRaw( 'loaderio-7fa45b57bc0a2a51cd5159425752f4f2' );
} );

server.head( '/:game/posts', ( request, response, next ) => {
    // Should add game checking
    response.status( SUCCESS_STATUS_CODE );
    response.end();
} );

server.head( '/', ( request, response, next ) => {
    response.status( SUCCESS_STATUS_CODE );
    response.end();
} );

server.get(
    '/:game/posts',
    // eslint-disable-next-line max-lines-per-function
    async (request, response) => {
        const cacheKey = getCacheKey(request);
        const cachedValue = myCache.get(cacheKey);

        if (cachedValue) {
            console.log('Cache hit!');

            response.json({
                // eslint-disable-next-line id-blacklist
                data: JSON.parse(cachedValue),
            });

            return true;
        }

        let gameAccounts = await getAccountsForGame(request.params.game);
        const query = {
            attributes: [
                'id',
                'timestamp',
                'accountId',
            ],
            where: {},
            limit: DEFAULT_POST_LIMIT,
            // Order by `timestamp + 0`, not `timestamp`. A plain
            // `ORDER BY timestamp DESC ... LIMIT` lets MySQL walk the
            // single-column posts_timestamp index backward and post-filter
            // `accountId IN (...)`, betting it hits the LIMIT quickly. For a
            // game whose posts aren't near the top of the global timeline
            // (quiet/older games) that bet is catastrophic — it scans most of
            // the table (csgo: 973k rows / ~147s measured). The `+ 0` denies
            // that index for ordering, so MySQL instead ranges over accountId_2
            // (this game's posts only) and filesorts the bounded set — csgo
            // drops to ~140ms, and tiny games can no longer full-scan. Search
            // (below) needs the same trick for its own reasons.
            order: [
                [
                    models.sequelize.literal( 'timestamp + 0' ),
                    'DESC',
                ],
            ],
        };

        response.cache( 'public', {
            maxAge: CACHE_TIMES.posts,
        } );

        if ( request.query.search ) {
            query.where = Object.assign(
                {},
                query.where,
                {
                    [ Op.or ]: [
                        {
                            content: {
                                [ Op.like ]: `%${ request.query.search }%`,
                            },
                        },
                        // {
                        //     '$account.developer.nick$': {
                        //         [ Op.like ]: `%${ request.query.search }%`,
                        //     },
                        // },
                    ],
                }
            );

            // Ordering already uses `timestamp + 0` (set on the base query
            // above). That's also what a rare-term search needs: a
            // leading-wildcard LIKE can't use an index, and ordering by the bare
            // `timestamp` would make MySQL content-scan the whole table
            // newest-first until it collects enough matches. Ranging over this
            // game's accounts and filesorting that bounded set is far cheaper.
        }

        if ( request.query.services ) {
            gameAccounts = gameAccounts.filter((gameAccount) => {
                return request.query.services.includes(gameAccount.service);
            });
        }

        if ( request.query.groups ) {
            gameAccounts = gameAccounts.filter((gameAccount) => {
                return request.query.groups.includes(gameAccount.developer.group);
            });
        }

        if ( request.query.excludeService ) {
            gameAccounts = gameAccounts.filter((gameAccount) => {
                return !request.query.excludeService.includes(gameAccount.service);
            });
        }

        if ( request.query.limit ) {
            const newLimit = Number( request.query.limit );

            if ( newLimit > 0 ) {
                query.limit = Math.min( newLimit, MAX_POST_LIMIT );
            }
        }

        if ( request.query.offset ) {
            const postOffset = Number( request.query.offset );

            if ( postOffset > MAX_POST_OFFSET ) {
                response.status( MALFORMED_REQUEST_STATUS_CODE );
                response.json( {
                    error: `offset must be <= ${ MAX_POST_OFFSET }`,
                } );

                return false;
            }

            if ( postOffset > 0 ) {
                query.offset = postOffset;
            }
        }

        query.where = Object.assign(
            {},
            query.where,
            {
                accountId: {
                    [Op.in]: gameAccounts.map((gameAccount) => {
                        return gameAccount.id;
                    }),
                },
            }
        );

        // Return the promise so restify awaits it. This handler is async, and
        // restify finalizes the response when the async function resolves — an
        // un-returned chain resolves immediately, so restify would send first
        // and the later .then() would hit ERR_HTTP_HEADERS_SENT.
        return models.Post.findAll( query )
            .then( ( postInstances ) => {
                const postIdList = [];

                for ( let i = 0; i < postInstances.length; i = i + 1 ) {
                    const post = postInstances[ i ].get();
                    postIdList.push(post.id);
                }

                const postQuery = {
                    attributes: [
                        'content',
                        'id',
                        'section',
                        'timestamp',
                        'topic',
                        'topicUrl',
                        'url',
                        'urlHash',
                    ],
                    include: [
                        {
                            attributes: [
                                'identifier',
                                'service',
                            ],
                            include: [
                                {
                                    attributes: [
                                        'group',
                                        'name',
                                        'nick',
                                        'role',
                                    ],
                                    include: [
                                        {
                                            attributes: [],
                                            model: models.Game,
                                        },
                                    ],
                                    model: models.Developer,
                                },
                            ],
                            model: models.Account,
                        },
                    ],
                    order: [
                        [
                            'timestamp',
                            'DESC',
                        ],
                    ],
                    where: {
                        id: {
                            [Op.in]: postIdList,
                        }
                    },
                };

                return models.Post.findAll(postQuery);
            } )
            .then( ( postInstances ) => {
                const posts = [];
                for ( let i = 0; i < postInstances.length; i = i + 1 ) {
                    const post = postInstances[ i ].get();

                    post.id = hashids.encode( post.id );
                    posts.push( post );
                }

                response.json( {
                    // eslint-disable-next-line id-blacklist
                    data: posts,
                } );

                if( posts.length > 0 ) {
                    myCache.set( cacheKey, JSON.stringify( posts ) );
                }
            } )
            .catch( ( findError ) => {
                // Don't rethrow: that hangs the request (no response) and logs a
                // misleading [fatal]. A DB pool-acquire timeout is transient, so
                // answer 503 and let the client retry.
                console.error( `[warn] posts query failed: ${ findError.message }` );
                response.status( SERVICE_UNAVAILABLE_STATUS_CODE );
                response.json( {
                    error: 'Temporarily unable to load posts, please retry.',
                } );
            } );
    }
);

server.get(
    '/:game/posts/:id',
    ( request, response, next ) => {
        const query = {
            attributes: [
                'content',
                'id',
                'timestamp',
                'topic',
                'topicUrl',
                'url',
            ],
            include: [
                {
                    attributes: [
                        'identifier',
                        'service',
                    ],
                    include: [
                        {
                            attributes: [
                                'group',
                                'name',
                                'nick',
                                'role',
                            ],
                            include: [
                                {
                                    attributes: [],
                                    model: models.Game,
                                    where: {
                                        identifier: request.params.game,
                                    },
                                },
                            ],
                            model: models.Developer,
                            where: {},
                        },
                    ],
                    model: models.Account,
                    where: {},
                },
            ],
            limit: 1,
            order: [
                [
                    'timestamp',
                    'DESC',
                ],
            ],
            where: {},
        };

        response.cache( 'public', {
            maxAge: CACHE_TIMES.singlePost,
        } );

        if ( Number( request.params.id ) ) {
            query.where = Object.assign(
                {},
                query.where,
                {
                    v1Id: request.params.id,
                }
            );
        } else {
            query.where = Object.assign(
                {},
                query.where,
                {
                    id: hashids.decode( request.params.id ),
                }
            );
        }

        models.Post.findAll( query )
            .then( ( postInstances ) => {
                if ( postInstances && postInstances[ 0 ] ) {
                    const post = postInstances[ 0 ].get();

                    post.id = hashids.encode( post.id );

                    response.json( {
                        // eslint-disable-next-line id-blacklist
                        data: [ post ],
                    } );
                } else {
                    response.status( NOT_FOUND_STATUS_CODE );
                    response.end();
                }
            } )
            .catch( ( findError ) => {
                // Transient DB pool-acquire timeout: answer 503 rather than
                // rethrowing (which would hang the request and log [fatal]).
                console.error( `[warn] single post query failed: ${ findError.message }` );
                response.status( SERVICE_UNAVAILABLE_STATUS_CODE );
                response.json( {
                    error: 'Temporarily unable to load post, please retry.',
                } );
            } );
    }
);

server.get(
    '/games',
    ( request, response, next ) => {
        models.Game.findAll(
            {
                attributes: [
                    'id',
                    'identifier',
                    'name',
                    'shortName',
                    'hostname',
                    'config',
                ],
            }
        )
            .then( ( fullGameData ) => {
                const responseData = [];
                let instantReponse = true;

                for ( const game of fullGameData ) {
                    const config = {};

                    if ( game.config ) {
                        // Offline games (config.live falsy) stay in the public
                        // response — "offline" only stops indexing, not visibility.
                        if ( game.config.boxart ) {
                            config.boxart = game.config.boxart;
                        }
                    }

                    responseData.push( {
                        config,
                        hostname: game.hostname,
                        identifier: game.identifier,
                        name: game.name,
                        shortName: game.shortName,
                    } );
                }

                if ( request.header( 'Authorization' ) ) {
                    const tokenMatch = request.header( 'Authorization' ).match( /Bearer (.*)/ );

                    if ( tokenMatch ) {
                        instantReponse = false;

                        const matchedToken = lookupToken( tokenMatch[ 1 ] );
                        let isAuthed = false;

                        if ( matchedToken && matchedToken.legacy ) {
                            isAuthed = legacyAuthorize( tokenMatch[ 1 ], request.route.path, request.method );
                        } else if ( matchedToken ) {
                            isAuthed = matchedToken.scopes.includes( 'admin' )
                                || matchedToken.scopes.includes( 'games:read' );
                        }

                        if ( isAuthed ) {
                            response.json( {
                                // eslint-disable-next-line id-blacklist
                                data: fullGameData,
                            } );
                        } else {
                            response.json( {
                                // eslint-disable-next-line id-blacklist
                                data: responseData,
                            } );
                        }
                    }
                }

                if ( instantReponse ) {
                    response.json( {
                        // eslint-disable-next-line id-blacklist
                        data: responseData,
                    } );
                }
            } )
            .catch( ( queryError ) => {
                console.log( queryError );
            } );
    }
);

server.get(
    '/:game/accounts',
    ...requireScope( 'accounts:read' ),
    async ( request, response ) => {
        let gameAccounts = await getAccountsForGame(request.params.game);

        if ( request.query.active && request.query.active.length > 0 ) {
            gameAccounts = gameAccounts.filter((gameAccount) => {
                return gameAccount.developer.active;
            });
        }

        if ( request.query.excludeService ) {
            gameAccounts = gameAccounts.filter((gameAccount) => {
                return !request.query.excludeService.includes(gameAccount.service);
            });
        }

        response.json({
            data: gameAccounts.map((gameAccount) => {
                return {
                    id: gameAccount.id,
                    identifier: gameAccount.identifier,
                    service: gameAccount.service,
                };
            }),
        });
    }
);

server.get(
    '/:game/developers',
    ...requireScope( 'developers:read' ),
    ( request, response, next ) => {
        const query = {
            include: [
                {
                    attributes: [],
                    model: models.Game,
                    where: {
                        identifier: request.params.game,
                    },
                },
                {
                    model: models.Account,
                },
            ],
            model: models.Developer,
            where: {},
        };

        models.Developer.findAll( query )
            .then( ( developers ) => {
                response.json( {
                    // eslint-disable-next-line id-blacklist
                    data: developers,
                } );
            } )
            .catch( ( queryError ) => {
                console.log( queryError );
            } );
    }
);

server.get(
    '/:game/hashes',
    ...requireScope( 'hashes:read' ),
    ( request, response, next ) => {
        const query = {
            attributes: [
                'urlHash',
            ],
            include: [
                {
                    attributes: [],
                    include: [
                        {
                            attributes: [],
                            include: [
                                {
                                    attributes: [],
                                    model: models.Game,
                                    where: {
                                        identifier: request.params.game,
                                    },
                                },
                            ],
                            model: models.Developer,
                            where: {},
                        },
                    ],
                    model: models.Account,
                    where: {},
                },
            ],
            where: {},
        };

        models.Post.findAll( query )
            .then( ( posts ) => {
                const urls = [];

                posts.forEach( ( post ) => {
                    urls.push( post.urlHash );
                } );

                response.json( {
                    // eslint-disable-next-line id-blacklist
                    data: urls,
                } );
            } )
            .catch( ( queryError ) => {
                console.log( queryError );
            } );
    }
);

server.get(
    '/:game/services',
    ( request, response, next ) => {
        const query = {
            attributes: [],
            include: [
                {
                    attributes: [
                        'service',
                    ],
                    include: [
                        {
                            attributes: [],
                            include: [
                                {
                                    attributes: [],
                                    model: models.Game,
                                    where: {
                                        identifier: request.params.game,
                                    },
                                },
                            ],
                            model: models.Developer,
                            where: {},
                        },
                    ],
                    model: models.Account,
                    where: {},
                },
            ],
            raw: true,
            where: {},
        };

        response.cache( 'public', {
            maxAge: CACHE_TIMES.services,
        } );

        models.Post.findAll( query )
            .then( ( serviceObjects ) => {
                const services = [];

                serviceObjects.forEach( ( currentObject ) => {
                    if ( services.includes( currentObject[ 'account.service' ] ) ) {
                        return true;
                    }

                    services.push( currentObject[ 'account.service' ] );
                } );

                response.json( {
                    // eslint-disable-next-line id-blacklist
                    data: alphanumSort(
                        services,
                        {
                            insensitive: true,
                        }
                    ),
                } );
            } )
            .catch( ( queryError ) => {
                console.log( queryError );
            } );
    }
);

server.get(
    '/:game/groups',
    ( request, response, next ) => {
        const query = {
            attributes: [
                'group',
            ],
            include: [
                {
                    attributes: [],
                    model: models.Game,
                    where: {
                        identifier: request.params.game,
                    },
                },
            ],
            model: models.Developer,
            where: {
                group: {
                    [ Op.and ]: [
                        {
                            [ Op.ne ]: null,
                        },
                        {
                            [ Op.ne ]: '',
                        },
                    ],
                },
            },
        };

        response.cache( 'public', {
            maxAge: CACHE_TIMES.groups,
        } );

        models.Developer.findAll( query )
            .then( ( groupObjects ) => {
                const groups = [];

                groupObjects.forEach( ( currentObject ) => {
                    groups.push( currentObject.group );
                } );

                response.json( {
                    // eslint-disable-next-line id-blacklist
                    data: alphanumSort(
                        [ ...new Set( groups ) ],
                        {
                            insensitive: true,
                        }
                    ),
                } );
            } )
            .catch( ( queryError ) => {
                console.log( queryError );
            } );
    }
);

server.get(
    '/stats',
    ...requireScope( 'stats:read' ),
    async ( request, response ) => {
        const cached = myCache.get( 'stats' );

        if ( cached ) {
            response.json( JSON.parse( cached ) );

            return;
        }

        try {
            const [ games, developers, accounts, posts ] = await Promise.all( [
                models.Game.count(),
                models.Developer.count(),
                models.Account.count(),
                models.Post.count(),
            ] );

            const nowSeconds = Math.floor( Date.now() / MILLISECONDS_PER_SECOND );
            const since24h = nowSeconds - SECONDS_PER_DAY;
            const since7d = nowSeconds - ( STATS_WEEK_DAYS * SECONDS_PER_DAY );
            const since30d = nowSeconds - ( STATS_WINDOW_DAYS * SECONDS_PER_DAY );
            const since90d = nowSeconds - ( STATS_QUARTER_DAYS * SECONDS_PER_DAY );

            // Posts grouped by account in a single rolling-window pass — this is
            // the only full scan of the posts table. Both the per-service and
            // per-game breakdowns are rolled up from these rows in JS below: an
            // account maps to exactly one service and (via its developer) one
            // game, so there's no need to scan posts again or join to accounts
            // just to group by service. The window bounds come from the server
            // clock (never user input), so inlining them in SUM() is safe.
            const perAccountRows = await models.Post.findAll( {
                attributes: [
                    'accountId',
                    [ models.sequelize.literal( 'COUNT(*)' ), 'total' ],
                    [ models.sequelize.literal( `SUM( timestamp >= ${ since24h } )` ), 'last24h' ],
                    [ models.sequelize.literal( `SUM( timestamp >= ${ since7d } )` ), 'last7d' ],
                    [ models.sequelize.literal( `SUM( timestamp >= ${ since30d } )` ), 'last30d' ],
                    [ models.sequelize.literal( `SUM( timestamp >= ${ since90d } )` ), 'last90d' ],
                ],
                group: [
                    'accountId',
                ],
                raw: true,
            } );

            // One row per account carrying both its service and owning game, so
            // a single query feeds both rollups. Every account has a non-null
            // developer→game FK, so the required join drops nothing.
            const accountRows = await models.Account.findAll( {
                attributes: [
                    'id',
                    'service',
                ],
                include: [
                    {
                        attributes: [
                            'gameId',
                        ],
                        model: models.Developer,
                        required: true,
                    },
                ],
                raw: true,
            } );

            const gameIdByAccount = {};
            const serviceByAccount = {};

            accountRows.forEach( ( row ) => {
                // The included gameId comes back under a Sequelize-prefixed raw
                // key (e.g. 'developer.gameId'); match it without hard-coding.
                const gameIdKey = Object.keys( row ).find( ( key ) => {
                    return ( /gameId$/i ).test( key );
                } );

                gameIdByAccount[ row.id ] = gameIdKey ? row[ gameIdKey ] : null;
                serviceByAccount[ row.id ] = row.service;
            } );

            const emptyCounts = () => {
                return {
                    '24h': 0,
                    '30d': 0,
                    '7d': 0,
                    '90d': 0,
                    all: 0,
                };
            };

            const addWindowCounts = ( target, row ) => {
                target[ '24h' ] += Number( row.last24h ) || 0;
                target[ '7d' ] += Number( row.last7d ) || 0;
                target[ '30d' ] += Number( row.last30d ) || 0;
                target[ '90d' ] += Number( row.last90d ) || 0;
                target.all += Number( row.total ) || 0;
            };

            const countByGameId = {};
            const countByService = {};

            perAccountRows.forEach( ( row ) => {
                const service = serviceByAccount[ row.accountId ];

                if ( service ) {
                    if ( !countByService[ service ] ) {
                        countByService[ service ] = emptyCounts();
                    }

                    addWindowCounts( countByService[ service ], row );
                }

                const gameId = gameIdByAccount[ row.accountId ];

                if ( gameId ) {
                    if ( !countByGameId[ gameId ] ) {
                        countByGameId[ gameId ] = emptyCounts();
                    }

                    addWindowCounts( countByGameId[ gameId ], row );
                }
            } );

            const postsPerService = Object.keys( countByService )
                .map( ( service ) => {
                    return {
                        counts: countByService[ service ],
                        service: service,
                    };
                } )
                .sort( ( a, b ) => {
                    return b.counts.all - a.counts.all;
                } );

            const gameRows = await models.Game.findAll( {
                attributes: [
                    'id',
                    'name',
                ],
                raw: true,
            } );

            const gameNameById = {};

            gameRows.forEach( ( game ) => {
                gameNameById[ game.id ] = game.name;
            } );

            const postsPerGame = Object.keys( countByGameId )
                .map( ( gameId ) => {
                    return {
                        counts: countByGameId[ gameId ],
                        name: gameNameById[ gameId ] || `#${ gameId }`,
                    };
                } )
                .sort( ( a, b ) => {
                    return b.counts.all - a.counts.all;
                } );

            const since = Math.floor( Date.now() / MILLISECONDS_PER_SECOND ) - ( STATS_WINDOW_DAYS * SECONDS_PER_DAY );
            const dateExpression = models.sequelize.fn(
                'DATE',
                models.sequelize.fn( 'FROM_UNIXTIME', models.sequelize.col( 'timestamp' ) )
            );

            const overTimeRows = await models.Post.findAll( {
                attributes: [
                    [ dateExpression, 'date' ],
                    [ models.sequelize.literal( 'COUNT(*)' ), 'count' ],
                ],
                group: [
                    dateExpression,
                ],
                order: [
                    models.sequelize.literal( 'date ASC' ),
                ],
                raw: true,
                where: {
                    timestamp: {
                        [ Op.gte ]: since,
                    },
                },
            } );

            const postsOverTime = overTimeRows.map( ( row ) => {
                return {
                    count: Number( row.count ),
                    date: row.date,
                };
            } );

            const payload = {
                postsOverTime: postsOverTime,
                postsPerGame: postsPerGame,
                postsPerService: postsPerService,
                totals: {
                    accounts: accounts,
                    developers: developers,
                    games: games,
                    posts: posts,
                },
            };

            myCache.set( 'stats', JSON.stringify( payload ), {
                ttl: CACHE_TIMES.stats * MILLISECONDS_PER_SECOND,
            } );

            response.json( payload );
        } catch ( statsError ) {
            console.error( statsError );
            response.send( INTERNAL_SERVER_ERROR_STATUS_CODE, {
                error: 'Failed to compute stats',
            } );
        }
    }
);

server.post(
    '/:game/posts',
    ...requireScope( 'posts:write' ),
    ( request, response, next ) => {
        models.Post.findOrCreate(
            {
                defaults: {
                    accountId: request.body.accountId,
                    content: request.body.content,
                    section: request.body.section,
                    timestamp: request.body.timestamp,
                    topic: request.body.topic,
                    topicUrl: request.body.topicUrl,
                    url: request.body.url,
                    urlHash: sha1( request.body.url ),
                },
                where: {
                    urlHash: sha1( request.body.url ),
                },
            }
        )
            .then( ( result ) => {
                const [ postInstance, created ] = result;

                if ( created ) {
                    console.log( `${ new Date() } - post added for ${ request.params.game }` );
                    // const post = postInstance.get();
                } else {
                    console.log( `Post with url ${ request.body.url } already exists` );

                    // Special case for reddit posts (because this shouldn't happen)
                    if ( request.body.url.includes( 'reddit.com' ) ) {
                        response.status( EXISTING_RESOURCE_STATUS_CODE );
                        response.end();

                        return true;
                    }
                }

                response.status(SUCCESS_STATUS_CODE);
                response.end();

                return true;
            } )
            .catch( ( postCreateError ) => {
                response.status( MALFORMED_REQUEST_STATUS_CODE );
                response.end();

                if ( postCreateError.fields ) {
                    console.log( `${ postCreateError.name }\n${ JSON.stringify( postCreateError.fields, null, JSON_INDENTATION ) }` );
                } else {
                    console.log( postCreateError );
                }
            } );
    }
);

server.post(
    '/:game/accounts',
    ...requireScope( 'accounts:write' ),
    ( request, response, next ) => {
        // console.log( request.body );
        models.Account.findOrCreate(
            {
                defaults: {
                    developerId: request.body.developerId,
                    identifier: request.body.identifier,
                    service: request.body.service,
                },
                where: {
                    identifier: request.body.identifier,
                    service: request.body.service,
                },
            }
        )
            .then( ( result ) => {
                const [ accountInstance, created ] = result;

                if ( created ) {
                    console.log( `${ new Date() } - account added` );
                    response.status(SUCCESS_STATUS_CODE);
                    response.end();
                } else {
                    response.status( EXISTING_RESOURCE_STATUS_CODE );
                    response.end();
                }
            } )
            .catch( ( accountCreateError ) => {
                response.status( MALFORMED_REQUEST_STATUS_CODE );
                response.end();

                if ( accountCreateError.fields ) {
                    console.log( `${ accountCreateError.name }\n${ JSON.stringify( accountCreateError.fields, null, JSON_INDENTATION ) }` );
                } else {
                    console.log( accountCreateError );
                }
            } );
    }
);

server.post(
    '/:game/developers',
    ...requireScope( 'developers:write' ),
    ( request, response, next ) => {
        models.Developer.findOrCreate(
            {
                defaults: {
                    active: request.body.active,
                    gameId: request.body.gameId,
                    group: request.body.group,
                    name: request.body.name,
                    nick: request.body.nick,
                    role: request.body.role,
                },
                where: {
                    gameId: request.body.gameId,
                    nick: request.body.nick,
                },
            }
        )
            .then( ( result ) => {
                const [ developerInstance, created ] = result;

                if ( created ) {
                    console.log( `${ new Date() } - developer added for ${ request.params.game }` );

                    response.status(SUCCESS_STATUS_CODE);
                    response.end();
                } else {
                    response.status( EXISTING_RESOURCE_STATUS_CODE );
                    response.end();
                }
            } )
            .catch( ( developerCreateError ) => {
                response.status( MALFORMED_REQUEST_STATUS_CODE );
                response.end();

                if ( developerCreateError.fields ) {
                    console.log( `${ developerCreateError.name }\n${ JSON.stringify( developerCreateError.fields, null, JSON_INDENTATION ) }` );
                } else {
                    console.log( developerCreateError );
                }
            } );
    }
);

server.post(
    '/games',
    ...requireScope( 'games:write' ),
    ( request, response, next ) => {
        models.Game.findOrCreate(
            {
                defaults: {
                    config: request.body.config,
                    hostname: request.body.hostname,
                    identifier: request.body.identifier,
                    name: request.body.name,
                    shortName: request.body.shortName,
                },
                where: {
                    identifier: request.body.identifier,
                },
            }
        )
            .then( ( result ) => {
                const [ gameInstance, created ] = result;

                if ( created ) {
                    console.log( `${ new Date() } - New game added, ${ request.body.identifier }` );
                    // const post = postInstance.get();
                } else {
                    console.log( `Game with identifier ${ request.body.identifier } already exists` );
                }

                response.status(SUCCESS_STATUS_CODE);
                response.end();
            } )
            .catch( ( gameCreateError ) => {
                response.status( MALFORMED_REQUEST_STATUS_CODE );
                response.end();

                if ( gameCreateError.fields ) {
                    console.log( `${ gameCreateError.name }\n${ JSON.stringify( gameCreateError.fields, null, JSON_INDENTATION ) }` );
                } else {
                    console.log( gameCreateError );
                }
            } );
    }
);

server.patch(
    '/games/:identifier',
    ...requireScope( 'games:write' ),
    ( request, response, next ) => {
        models.Game.update(
            request.body.properties,
            {
                where: {
                    identifier: request.params.identifier,
                },
            }
        )
            .then( ( result ) => {
                if ( result[ 0 ] > 0 ) {
                    console.log( `${ new Date() } - ${ request.params.identifier } updated` );

                    response.status(SUCCESS_STATUS_CODE);
                    response.end();
                } else {
                    // console.log( result );
                    response.status( NOT_FOUND_STATUS_CODE );
                    response.end();
                }
            } )
            .catch( ( gameUpdateError ) => {
                response.status( MALFORMED_REQUEST_STATUS_CODE );
                response.end();

                if ( gameUpdateError.fields ) {
                    console.log( `${ gameUpdateError.name }\n${ JSON.stringify( gameUpdateError.fields, null, JSON_INDENTATION ) }` );
                } else {
                    console.log( gameUpdateError );
                }
            } );
    }
);

server.patch(
    '/:game/developers/:id',
    ...requireScope( 'developers:write' ),
    ( request, response, next ) => {
        models.Developer.update(
            request.body.properties,
            {
                where: {
                    id: request.params.id,
                },
            }
        )
            .then( ( result ) => {
                if ( result[ 0 ] > 0 ) {
                    console.log( `${ new Date() } - ${ result[ 0 ] } developers updated` );
                }

                response.status(SUCCESS_STATUS_CODE);
                response.end();
            } )
            .catch( ( developerCreateError ) => {
                response.status( MALFORMED_REQUEST_STATUS_CODE );
                response.end();

                if ( developerCreateError.fields ) {
                    console.log( `${ developerCreateError.name }\n${ JSON.stringify( developerCreateError.fields, null, JSON_INDENTATION ) }` );
                } else {
                    console.log( developerCreateError );
                }
            } );
    }
);

server.post(
    '/:game/developers/:id/merge',
    ...requireScope( 'developers:write' ),
    ( request, response, next ) => {
        const sourceId = Number( request.params.id );
        const targetId = Number( request.body && request.body.targetId );

        // Reject a missing target or a merge of a developer into itself.
        if ( !targetId || sourceId === targetId ) {
            response.status( MALFORMED_REQUEST_STATUS_CODE );
            response.end();

            return;
        }

        models.Game.findOne( {
            where: {
                identifier: request.params.game,
            },
        } )
            .then( ( game ) => {
                if ( !game ) {
                    return false;
                }

                // Both developers must exist and belong to this game; this
                // blocks cross-game merges and stale ids.
                return Promise.all( [
                    models.Developer.findOne( { where: { gameId: game.id, id: sourceId } } ),
                    models.Developer.findOne( { where: { gameId: game.id, id: targetId } } ),
                ] )
                    .then( ( [ source, target ] ) => {
                        if ( !source || !target ) {
                            return false;
                        }

                        // Reassign the source's accounts first, then delete the
                        // now-empty source. Order matters: Developer->Account is
                        // onDelete CASCADE, so deleting a developer that still
                        // owned accounts would cascade-delete them and their
                        // posts. Wrap both in a transaction so a failure rolls
                        // back rather than orphaning or losing data.
                        return models.sequelize.transaction( ( transaction ) => {
                            return models.Account.update(
                                {
                                    developerId: targetId,
                                },
                                {
                                    transaction: transaction,
                                    where: {
                                        developerId: sourceId,
                                    },
                                }
                            )
                                .then( () => {
                                    return models.Developer.destroy( {
                                        transaction: transaction,
                                        where: {
                                            id: sourceId,
                                        },
                                    } );
                                } );
                        } )
                            .then( () => {
                                return true;
                            } );
                    } );
            } )
            .then( ( merged ) => {
                if ( merged ) {
                    console.log( `${ new Date() } - developer ${ sourceId } merged into ${ targetId } for ${ request.params.game }` );

                    response.status( SUCCESS_STATUS_CODE );
                } else {
                    response.status( NOT_FOUND_STATUS_CODE );
                }

                response.end();
            } )
            .catch( ( mergeError ) => {
                response.status( MALFORMED_REQUEST_STATUS_CODE );
                response.end();

                console.log( mergeError );
            } );
    }
);

server.patch(
    '/:game/accounts/:id',
    ...requireScope( 'accounts:write' ),
    ( request, response, next ) => {
        models.Account.update(
            request.body.properties,
            {
                where: {
                    id: request.params.id,
                },
            }
        )
            .then( ( result ) => {
                if ( result[ 0 ] > 0 ) {
                    console.log( `${ new Date() } - ${ result[ 0 ] } accounts updated` );
                }

                response.status(SUCCESS_STATUS_CODE);
                response.end();
            } )
            .catch( ( developerCreateError ) => {
                response.status( MALFORMED_REQUEST_STATUS_CODE );
                response.end();

                if ( developerCreateError.fields ) {
                    console.log( `${ developerCreateError.name }\n${ JSON.stringify( developerCreateError.fields, null, JSON_INDENTATION ) }` );
                } else {
                    console.log( developerCreateError );
                }
            } );
    }
);

server.del(
    '/:game/accounts/:id',
    ...requireScope( 'accounts:delete' ),
    ( request, response, next ) => {
        // console.log( request.body );
        models.Account.destroy(
            {
                where: {
                    id: request.params.id,
                },
            }
        )
            .then( ( deletedCount ) => {
                if ( deletedCount === 1 ) {
                    console.log( `${ new Date() } - account deleted` );
                    // console.log( accountInstance.get() );
                } else {
                    console.log( `${ deletedCount } accounts deleted` );
                }

                response.status(SUCCESS_STATUS_CODE);
                response.end();
            } )
            .catch( ( accountDeleteError ) => {
                response.status( MALFORMED_REQUEST_STATUS_CODE );
                response.end();

                if ( accountDeleteError.fields ) {
                    console.log( `${ accountDeleteError.name }\n${ JSON.stringify( accountDeleteError.fields, null, JSON_INDENTATION ) }` );
                } else {
                    console.log( accountDeleteError );
                }
            } );
    }
);

server.del(
    '/:game/posts/:url',
    ...requireScope( 'posts:delete' ),
    ( request, response, next ) => {
        models.Post.destroy(
            {
                where: {
                    url: request.params.url,
                },
            }
        )
            .then( ( deletedCount ) => {
                if ( deletedCount >= 1 ) {
                    if ( deletedCount === 1 ) {
                        console.log( `${ new Date() } - post ${ request.params.url } deleted` );
                    } else {
                        console.log( `${ deletedCount } posts deleted` );
                    }

                    response.status(SUCCESS_STATUS_CODE);
                    response.end();
                } else {
                    response.status( NOT_FOUND_STATUS_CODE );
                    response.end();
                }
            } )
            .catch( ( postDeleteError ) => {
                response.status( MALFORMED_REQUEST_STATUS_CODE );
                response.end();

                if ( postDeleteError.fields ) {
                    console.log( `${ postDeleteError.name }\n${ JSON.stringify( postDeleteError.fields, null, JSON_INDENTATION ) }` );
                } else {
                    console.log( postDeleteError );
                }
            } );
    }
);

server.head(
    '/:game/posts/:hash',
    ( request, response, next ) => {
        const query = {
            where: {
                urlHash: request.params.hash,
            },
        };

        if ( postsCache.has( request.params.hash ) ) {
            response.status( SUCCESS_STATUS_CODE );
            response.end();

            return true;
        }

        models.Post.count( query )
            .then( ( postCount ) => {
                if ( postCount ) {
                    postsCache.set( request.params.hash, true );

                    response.cache( 'public', {
                        maxAge: CACHE_TIMES.singlePost,
                    } );

                    response.status( SUCCESS_STATUS_CODE );
                    response.end();
                } else {
                    response.cache( 'public', {
                        maxAge: CACHE_TIMES.singlePostHead,
                    } );

                    response.status( NOT_FOUND_STATUS_CODE );
                    response.end();
                }
            } )
            .catch( ( findError ) => {
                // HEAD: transient DB pool-acquire timeout -> 503, no body.
                console.error( `[warn] single post HEAD query failed: ${ findError.message }` );
                response.status( SERVICE_UNAVAILABLE_STATUS_CODE );
                response.end();
            } );
    }
);

server.get(
    '/tokens',
    ...requireScope( 'tokens:manage' ),
    async ( request, response ) => {
        try {
            const tokens = await models.Token.findAll( {
                attributes: [
                    'id',
                    'name',
                    'scopes',
                    'active',
                    'createdAt',
                ],
                order: [
                    [ 'createdAt', 'DESC' ],
                ],
            } );

            response.json( {
                // eslint-disable-next-line id-blacklist
                data: tokens,
            } );
        } catch ( tokensError ) {
            console.error( tokensError );
            response.send( INTERNAL_SERVER_ERROR_STATUS_CODE, {
                error: 'Failed to list tokens',
            } );
        }
    }
);

server.post(
    '/tokens',
    ...requireScope( 'tokens:manage' ),
    async ( request, response ) => {
        const name = request.body && request.body.name;
        const scopes = request.body && request.body.scopes;

        if ( !name || !Array.isArray( scopes ) || scopes.length === 0 ) {
            response.send( MALFORMED_REQUEST_STATUS_CODE, {
                error: 'name and a non-empty scopes array are required',
            } );

            return;
        }

        try {
            const created = await models.Token.create( {
                active: true,
                name: name,
                scopes: scopes,
                token: generateToken(),
            } );

            await loadTokens();

            // The full token is returned only here, at creation time.
            response.json( {
                // eslint-disable-next-line id-blacklist
                data: {
                    id: created.id,
                    name: created.name,
                    scopes: created.scopes,
                    token: created.token,
                },
            } );
        } catch ( createError ) {
            console.error( createError );
            response.send( INTERNAL_SERVER_ERROR_STATUS_CODE, {
                error: 'Failed to create token',
            } );
        }
    }
);

server.del(
    '/tokens/:id',
    ...requireScope( 'tokens:manage' ),
    async ( request, response ) => {
        try {
            await models.Token.destroy( {
                where: {
                    id: request.params.id,
                },
            } );

            await loadTokens();

            response.send( SUCCESS_STATUS_CODE );
        } catch ( deleteError ) {
            console.error( deleteError );
            response.send( INTERNAL_SERVER_ERROR_STATUS_CODE, {
                error: 'Failed to delete token',
            } );
        }
    }
);

// restify passes (req, res, err, callback) here and won't finalize/send the
// error response until the callback is invoked — omitting it (as before)
// leaves the socket hanging on every error (e.g. a missing static file).
// eslint-disable-next-line max-params
server.on( 'restifyError', ( request, response, error, callback ) => {
    console.log( error );

    return callback();
} );

process.on( 'uncaughtException', ( error ) => {
    console.error( `[fatal] uncaughtException ${ new Date().toISOString() }`, error );
    process.exit( 1 );
} );

process.on( 'unhandledRejection', ( reason ) => {
    console.error( `[fatal] unhandledRejection ${ new Date().toISOString() }`, reason );
} );

server.listen( LISTEN_PORT, () => {
    console.log( '%s listening at %s', server.name, server.url );
} );
