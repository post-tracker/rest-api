const path = require( 'path' );

const restify = require( 'restify' );
const jsonfile = require( 'jsonfile' )
const passport = require( 'passport' );
const Strategy = require( 'passport-http-bearer' ).Strategy;

const models = require( './models' );

const LISTEN_PORT = 3000;

const server = restify.createServer( {
    // eslint-disable-next-line no-sync
    // certificate: fs.readFileSync( 'cert.pem' ),
    // eslint-disable-next-line no-sync
    // key: fs.readFileSync( 'key.pem' ),
    name: 'Post tracker REST API',
} );

passport.use(new Strategy(
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

            if ( !tokenData[ token ].paths.includes( request.route.path ) ) {
                console.log( `${ token } not authenticated for ${ request.route.path }` );
                return authenticationCallback( null, false );
            }

            return authenticationCallback( null, true );
        } );
    }
) );

const defaultQuery = {
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

server.use( restify.queryParser() );
server.use( restify.gzipResponse() );

// Implement restify redirect so we can use passport
// https://coderwall.com/p/arjzog/make-passport-work-with-restify-by-fixing-redirect-functionality-with-this-snippet
server.use( ( request, response, next ) => {
    response.redirect = ( address ) => {
        response.header( 'Location', address );
        response.send( 302 );
    };

    next();
} );

server.get( '/', ( request, response ) => {
    response.send( 'Hello' );
} );

server.get( '/:game/posts', ( request, response ) => {
    const query = Object.assign( {}, defaultQuery );

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
                    $in: request.query.services.split( ',' ),
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
                    $in: request.query.groups.split( ',' ),
                },
            }
        );
    }

    models.Post.findAll( query )
        .then( ( posts ) => {
            response.send( posts );
        } )
        .catch( ( findError ) => {
            throw findError;
        } );
} );

server.get( '/:game/posts/:id', ( request, response ) => {
    const query = Object.assign( {}, defaultQuery );

    query.include[ 0 ].include[ 0 ].include[ 0 ].where = {
        identifier: request.params.game,
    };

    query.where = Object.assign(
        {},
        query.where,
        {
            id: request.params.id,
        }
    );

    models.Post.findAll( query )
        .then( ( posts ) => {
            response.send( posts );
        } )
        .catch( ( findError ) => {
            throw findError;
        } );
} );

server.get(
    '/games',
    passport.authenticate( 'bearer', {
        session: false,
    } ),
    ( request, response ) => {
        models.Game.findAll(
            {
                attributes: [
                    'identifier',
                    'name',
                    'shortName',
                ],
            }
        )
            .then( ( games ) => {
                response.send( games );
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
        models.Account.findAll(
            {
                attributes: [
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
            }
        )
            .then( ( accounts ) => {
                response.send( accounts );
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
        response.send( 'OK' );
    }
);

server.post(
    '/:game/accounts',
    passport.authenticate( 'bearer', {
        session: false,
    } ),
    ( request, response ) => {
        response.send( 'OK' );
    }
);

server.post(
    '/:game/developers',
    passport.authenticate( 'bearer', {
        session: false,
    } ),
    ( request, response ) => {
        response.send( 'OK' );
    }
);

server.post(
    '/:game/games',
    passport.authenticate( 'bearer', {
        session: false,
    } ),
    ( request, response ) => {
        response.send( 'OK' );
    }
);

// eslint-disable-next-line max-params
server.on( 'uncaughtException', ( request, response, route, error ) => {
    console.log( `uncaughtException for ${ route.spec.method } ${ route.spec.path }` );
    console.log( error );
} );

server.listen( LISTEN_PORT, () => {
    console.log( '%s listening at %s', server.name, server.url );
} );
