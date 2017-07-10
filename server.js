const path = require( 'path' );
const fs = require( 'fs' );

const sha1 = require( 'sha1' );
const restify = require( 'restify' );
const jsonfile = require( 'jsonfile' );
const passport = require( 'passport' );
const alphanumSort = require( 'alphanum-sort' );
const Hashids = require( 'hashids' );
const Strategy = require( 'passport-http-bearer' ).Strategy;
const corsMiddleware = require( 'restify-cors-middleware' );

const models = require( './models' );

const LISTEN_PORT = 3000;
const JSON_INDENTATION = 4;
const INTERNAL_SERVER_ERROR_STATUS_CODE = 500;
const MALFORMED_REQUEST_STATUS_CODE = 400;
const NOT_FOUND_STATUS_CODE = 404;
const EXISTING_RESOURCE_STATUS_CODE = 409;
const ID_HASH_MIN_LENGTH = 8;

const hashids = new Hashids( '', ID_HASH_MIN_LENGTH, 'abcdefghijklmnopqrstuvwxyz' );

const server = restify.createServer( {
    // eslint-disable-next-line no-sync
    certificate: fs.readFileSync( path.join( __dirname, './assets/fullchain.pem' ) ),
    // eslint-disable-next-line no-sync
    key: fs.readFileSync( path.join( __dirname, './assets/privkey.pem' ) ),
    name: 'Post tracker REST API',
} );

passport.use( new Strategy(
    {
        passReqToCallback: true,
    },
    ( request, token, authenticationCallback ) => {
        jsonfile.readFile( path.join( __dirname, 'config/tokens.json' ), ( readError, tokenData ) => {
            if ( readError ) {
                return authenticationCallback( readError );
            }

            if ( !tokenData[ token ] ) {
                return authenticationCallback( null, false );
            }

            if ( !tokenData[ token ].paths[ request.route.path ] ) {
                console.log( `${ token } not authenticated for ${ request.route.path }` );

                return authenticationCallback( null, false );
            }

            if ( !tokenData[ token ].paths[ request.route.path ].includes( request.method ) ) {
                console.log( `${ token } not authenticated for ${ request.method } on ${ request.route.path }` );

                return authenticationCallback( null, false );
            }

            return authenticationCallback( null, true );
        } );
    }
) );

const cors = corsMiddleware( {
    allowHeaders: [ 'authorization' ],
    exposeHeaders: [ 'authorization' ],
    origins: [ '*' ],
} );

server.pre( cors.preflight );
server.use( cors.actual );
server.use( restify.plugins.bodyParser() );
server.use( restify.plugins.queryParser() );
server.use( restify.plugins.gzipResponse() );

server.get( '/', ( request, response ) => {
    response.send( 'Wanna do cool stuff? Msg me wherever /u/Kokarn kokarn@gmail @oskarrisberg' );
} );

server.get(
    '/:game/posts',
    ( request, response ) => {
        const query = {
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
                                    where: {},
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
            limit: 50,
            order: [
                [
                    'timestamp',
                    'DESC',
                ],
            ],
            where: {},
        };

        query.include[ 0 ].include[ 0 ].include[ 0 ].where = {
            identifier: request.params.game,
        };

        if ( request.query.search ) {
            query.where = Object.assign(
                {},
                query.where,
                {
                    content: {
                        $like: `%${ request.query.search }%`,
                    },
                }
            );
        }

        if ( request.query.services ) {
            query.include[ 0 ].where = Object.assign(
                {},
                query.include[ 0 ].where,
                {
                    service: {
                        $in: request.query.services,
                    },
                }
            );
        }

        if ( request.query.groups ) {
            query.include[ 0 ].include[ 0 ].where = Object.assign(
                {},
                query.include[ 0 ].include[ 0 ].where,
                {
                    group: {
                        $in: request.query.groups,
                    },
                }
            );
        }

        if ( request.query.excludeService ) {
            let serviceWhere = {};

            if ( query.include[ 0 ].where.service ) {
                serviceWhere = query.include[ 0 ].where.service;
            }

            serviceWhere.$notIn = [ request.query.excludeService ];

            query.include[ 0 ].where = Object.assign(
                {},
                query.include[ 0 ].where,
                {
                    service: serviceWhere,
                }
            );
        }

        models.Post.findAll( query )
            .then( ( postInstances ) => {
                const posts = [];

                for ( let i = 0; i < postInstances.length; i = i + 1 ) {
                    const post = postInstances[ i ].get();

                    post.id = hashids.encode( post.id );
                    posts.push( post );
                }

                response.send( {
                    // eslint-disable-next-line id-blacklist
                    data: posts,
                } );
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

                    response.send( {
                        // eslint-disable-next-line id-blacklist
                        data: [ post ],
                    } );
                } else {
                    response.send( NOT_FOUND_STATUS_CODE );
                }
            } )
            .catch( ( findError ) => {
                throw findError;
            } );
    }
);

server.get(
    '/games',
    passport.authenticate( 'bearer', {
        session: false,
    } ),
    ( request, response ) => {
        models.Game.findAll(
            {
                attributes: [
                    'id',
                    'identifier',
                    'name',
                    'shortName',
                ],
            }
        )
            .then( ( games ) => {
                response.send( {
                    // eslint-disable-next-line id-blacklist
                    data: games,
                } );
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
    ( request, response ) => {
        const query = {
            attributes: [
                'id',
                'identifier',
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
        };

        if ( request.query.active && request.query.active.length > 0 ) {
            const active = Number( request.query.active );

            query.include[ 0 ].where.active = active;
        }

        models.Account.findAll( query )
            .then( ( accounts ) => {
                response.send( {
                    // eslint-disable-next-line id-blacklist
                    data: accounts,
                } );
            } )
            .catch( ( queryError ) => {
                console.log( queryError );
            } );
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
                response.send( {
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

                response.send( {
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
        };

        models.Account.findAll( query )
            .then( ( serviceObjects ) => {
                const services = [];

                serviceObjects.forEach( ( currentObject ) => {
                    services.push( currentObject.service );
                } );

                response.send( {
                    // eslint-disable-next-line id-blacklist
                    data: alphanumSort(
                        [ ...new Set( services ) ],
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
                    $ne: null,
                },
            },
        };

        models.Developer.findAll( query )
            .then( ( groupObjects ) => {
                const groups = [];

                groupObjects.forEach( ( currentObject ) => {
                    groups.push( currentObject.group );
                } );

                response.send( {
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
            }

            response.send( 'OK' );
        } )
        .catch( ( postCreateError ) => {
            response.send( MALFORMED_REQUEST_STATUS_CODE );
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
                response.send( 'OK' );
            } else {
                response.send( EXISTING_RESOURCE_STATUS_CODE );
            }
        } )
        .catch( ( accountCreateError ) => {
            response.send( MALFORMED_REQUEST_STATUS_CODE );
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
                response.send( 'OK' );
            } else {
                response.send( EXISTING_RESOURCE_STATUS_CODE );
            }
        } )
        .catch( ( developerCreateError ) => {
            response.send( MALFORMED_REQUEST_STATUS_CODE );
            if ( developerCreateError.fields ) {
                console.log( `${ developerCreateError.name }\n${ JSON.stringify( developerCreateError.fields, null, JSON_INDENTATION ) }` );
            } else {
                console.log( developerCreateError );
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

            response.send( 'OK' );
        } )
        .catch( ( developerCreateError ) => {
            response.send( MALFORMED_REQUEST_STATUS_CODE );
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

            response.send( 'OK' );
        } )
        .catch( ( developerCreateError ) => {
            response.send( MALFORMED_REQUEST_STATUS_CODE );
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

            response.send( 'OK' );
        } )
        .catch( ( accountDeleteError ) => {
            response.send( MALFORMED_REQUEST_STATUS_CODE );

            if ( accountDeleteError.fields ) {
                console.log( `${ accountDeleteError.name }\n${ JSON.stringify( accountDeleteError.fields, null, JSON_INDENTATION ) }` );
            } else {
                console.log( accountDeleteError );
            }
        } );
    }
);

// eslint-disable-next-line max-params
server.on( 'uncaughtException', ( request, response, route, error ) => {
    console.log( `uncaughtException for ${ route.spec.method } ${ route.spec.path }` );
    console.log( error );
    response.send( INTERNAL_SERVER_ERROR_STATUS_CODE );
} );

server.listen( LISTEN_PORT, () => {
    console.log( '%s listening at %s', server.name, server.url );
} );
