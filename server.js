require('dotenv').config();

const sha1 = require( 'sha1' );
const restify = require( 'restify' );
const passport = require( 'passport' );
const alphanumSort = require( 'alphanum-sort' );
const Hashids = require( 'hashids' );
const Strategy = require( 'passport-http-bearer' ).Strategy;
const corsMiddleware = require( 'restify-cors-middleware' );
const { Op } = require('sequelize');
const NodeCache = require('node-cache');

const models = require( './models' );
const processor = require( './modules/processor.js' );

const LISTEN_PORT = process.env.PORT || 3000;
const JSON_INDENTATION = 4;
const SUCCESS_STATUS_CODE = 200;
const INTERNAL_SERVER_ERROR_STATUS_CODE = 500;
const MALFORMED_REQUEST_STATUS_CODE = 400;
const NOT_FOUND_STATUS_CODE = 404;
const EXISTING_RESOURCE_STATUS_CODE = 409;
const ID_HASH_MIN_LENGTH = 8;
const MAX_POST_LIMIT = 1000;
const DEFAULT_POST_LIMIT = 50;
const CACHE_TIMES = {
    favicon: 2592000,
    groups: 3600,
    posts: 900,
    services: 3600,
    singlePost: 2592000,
    singlePostHead: 600,
};

const hashids = new Hashids( '', ID_HASH_MIN_LENGTH, 'abcdefghijklmnopqrstuvwxyz' );

const server = restify.createServer( {
    // eslint-disable-next-line no-sync
    // certificate: fs.readFileSync( path.join( __dirname, './assets/fullchain.pem' ) ),
    // eslint-disable-next-line no-sync
    // key: fs.readFileSync( path.join( __dirname, './assets/privkey.pem' ) ),
    name: 'Post tracker REST API',
} );

const tokenData = JSON.parse(process.env.API_TOKENS);

const myCache = new NodeCache();

const authenticate = function authenticate ( routePath, method, token ) {
    if ( !tokenData[ token ] ) {
        return false;
    }

    if ( !tokenData[ token ].paths[ routePath ] ) {
        console.log( `${ token } not authenticated for ${ routePath }` );

        return false;
    }

    if ( !tokenData[ token ].paths[ routePath ].includes( method ) ) {
        console.log( `${ token } not authenticated for ${ method } on ${ routePath }` );

        return false;
    }

    return true;
};

passport.use( new Strategy(
    {
        passReqToCallback: true,
    },
    ( request, token, authenticationCallback ) => {
        const authenticationResult = authenticate( request.route.path, request.method, token );

        return authenticationCallback( null, authenticationResult );
    }
) );

const cors = corsMiddleware( {
    allowHeaders: [ 'authorization' ],
    exposeHeaders: [ 'authorization' ],
    origins: [ '*' ],
} );

const addHeader = ( request, response, next ) => {
    response.setHeader( 'vary', 'accept-encoding' );
    next();
};

server.pre( cors.preflight );
server.use( cors.actual );
server.use( restify.plugins.bodyParser() );
server.use( restify.plugins.queryParser() );
server.use( restify.plugins.gzipResponse() );
server.use( addHeader );

processor();

const postsCache = [];
let allAccounts = [];

const getCacheKey = ( request ) => {
    let cacheKey = request.params.game;

    cacheKey = `${ cacheKey }/${ request.params.path }`;

    if ( request.query.search ) {
        cacheKey = `${ cacheKey }/${ request.query.search }`;
    }

    if ( request.query.services ) {
        cacheKey = `${ cacheKey }/${ request.query.services.join(',') }`;
    }

    if ( request.query.groups ) {
        cacheKey = `${ cacheKey }/${ request.query.groups.join(',') }`;
    }

    if ( request.query.excludeService ) {
        if( Array.isArray( request.query.excludeService ) ) {
            cacheKey = `${ cacheKey }/${ request.query.excludeService.join(',') }`;
        } else {
            cacheKey = `${ cacheKey }/${ request.query.excludeService }`;
        }
    }

    if ( request.query.limit ) {
        cacheKey = `${ cacheKey }/${ request.query.limit }`;
    }

    if ( request.query.offset ) {
        cacheKey = `${ cacheKey }/${ request.query.offset }`;
    }

    return cacheKey;
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
            throw findError;
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
server.get( /\/.*\..+?/, restify.plugins.serveStatic( {
    default: 'index.json',
    directory: './static',
} ) );

server.get( '/', ( request, response ) => {
    response.json( 'Wanna do cool stuff? Msg me wherever /u/Kokarn kokarn@gmail @oskarrisberg' );
} );

server.get( '/loaderio-7fa45b57bc0a2a51cd5159425752f4f2/', ( request, response ) => {
    response.sendRaw( 'loaderio-7fa45b57bc0a2a51cd5159425752f4f2' );
} );

server.head( '/:game/posts', ( request, response ) => {
    // Should add game checking
    response.status( SUCCESS_STATUS_CODE );
    response.end();
} );

server.head( '/', ( request, response ) => {
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
            order: [
                [
                    'timestamp',
                    'DESC',
                ],
            ],
            logging: console.log,
        };

        response.cache( 'public', {
            maxAge: CACHE_TIMES.posts,
        } );

        if ( request.query.search ) {
            query.where = Object.assign(
                {},
                query.where,
                {
                    $or: [
                        {
                            content: {
                                $like: `%${ request.query.search }%`,
                            },
                        },
                        // {
                        //     '$account.developer.nick$': {
                        //         $like: `%${ request.query.search }%`,
                        //     },
                        // },
                    ],
                }
            );
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

        models.Post.findAll( query )
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
                    myCache.set(cacheKey, JSON.stringify(posts), CACHE_TIMES.posts);
                }
            } )
            .catch( ( findError ) => {
                throw findError;
            } );
    }
);

server.get(
    '/:game/posts/:id',
    ( request, response ) => {
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
                throw findError;
            } );
    }
);

server.get(
    '/games',
    ( request, response ) => {
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
                        if ( typeof game.config.live !== 'undefined' && !game.config.live ) {
                            continue;
                        }

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

                        const isAuthed = authenticate( request.route.path, request.method, tokenMatch[ 1 ] )
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
    passport.authenticate( 'bearer', {
        session: false,
    } ),
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
    passport.authenticate( 'bearer', {
        session: false,
    } ),
    ( request, response ) => {
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
    passport.authenticate( 'bearer', {
        session: false,
    } ),
    ( request, response ) => {
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
    ( request, response ) => {
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
    ( request, response ) => {
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
                    $and: [
                        {
                            $ne: null,
                        },
                        {
                            $ne: '',
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

server.post(
    '/:game/posts',
    passport.authenticate( 'bearer', {
        session: false,
    } ),
    ( request, response ) => {
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
    passport.authenticate( 'bearer', {
        session: false,
    } ),
    ( request, response ) => {
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
    passport.authenticate( 'bearer', {
        session: false,
    } ),
    ( request, response ) => {
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
    passport.authenticate( 'bearer', {
        session: false,
    } ),
    ( request, response ) => {
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
    passport.authenticate( 'bearer', {
        session: false,
    } ),
    ( request, response ) => {
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
    passport.authenticate( 'bearer', {
        session: false,
    } ),
    ( request, response ) => {
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

server.patch(
    '/:game/accounts/:id',
    passport.authenticate( 'bearer', {
        session: false,
    } ),
    ( request, response ) => {
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
    passport.authenticate( 'bearer', {
        session: false,
    } ),
    ( request, response ) => {
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
    passport.authenticate( 'bearer', {
        session: false,
    } ),
    ( request, response ) => {
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
    ( request, response ) => {
        const query = {
            where: {
                urlHash: request.params.hash,
            },
        };

        if(postsCache.includes(request.params.hash)){
            response.status( SUCCESS_STATUS_CODE );
            response.end();

            return true;
        }

        models.Post.count( query )
            .then( ( postCount ) => {
                if ( postCount ) {
                    postsCache.push(request.params.hash);

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
                throw findError;
            } );
    }
);

// eslint-disable-next-line max-params
server.on( 'restifyError', ( request, response, error ) => {
    console.log(error);
    // switch ( error.body.code ) {
    //     case 'ResourceNotFound':
    //         response.status( NOT_FOUND_STATUS_CODE );
    //         response.end();
    //         break;
    //     default:
    //         console.error( `uncaughtException for ${ error }` );
    //         response.status( INTERNAL_SERVER_ERROR_STATUS_CODE );
    //         response.end();
    //         break;
    // }
} );

server.listen( LISTEN_PORT, () => {
    console.log( '%s listening at %s', server.name, server.url );
} );
