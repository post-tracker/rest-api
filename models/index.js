const path = require( 'path' );

const Sequelize = require( 'sequelize' );

// eslint-disable-next-line no-process-env
const env = process.env.NODE_ENV || 'development';
const config = require( path.join( __dirname, '/../config.json' ) )[ env ];
const models = {};
// config.benchmark = true;
// config.logging = (sql, time /*ms*/) => {
//     console.log( time, sql );
// };

config.host = process.env.DB_HOST;

const sequelize = new Sequelize( 'devtracker', process.env.DB_USERNAME, process.env.DB_PASSWORD, config );

models.Game = sequelize.define(
    'game',
    {
        config: {
            type: Sequelize.JSON,
        },
        hostname: {
            type: Sequelize.STRING,
        },
        id: {
            autoIncrement: true,
            primaryKey: true,
            type: Sequelize.INTEGER,
        },
        identifier: {
            type: Sequelize.STRING,
            unique: true,
        },
        name: {
            type: Sequelize.STRING,
        },
        shortName: {
            type: Sequelize.STRING,
        },
    },
    {
        charset: 'utf8mb4',
        collate: 'utf8mb4_general_ci',
    }
);

models.Developer = sequelize.define(
    'developer',
    {
        active: {
            defaultValue: true,
            type: Sequelize.BOOLEAN,
        },
        group: {
            type: Sequelize.STRING,
        },
        id: {
            allowNull: false,
            autoIncrement: true,
            primaryKey: true,
            type: Sequelize.INTEGER,
        },
        name: {
            type: Sequelize.STRING,
        },
        nick: {
            type: Sequelize.STRING,
        },
        role: {
            type: Sequelize.STRING,
        },
        v1Id: {
            type: Sequelize.INTEGER,
        },
    },
    {
        charset: 'utf8mb4',
        collate: 'utf8mb4_general_ci',
    }
);

models.Account = sequelize.define(
    'account',
    {
        id: {
            autoIncrement: true,
            primaryKey: true,
            type: Sequelize.INTEGER,
        },
        identifier: {
            allowNull: false,
            type: Sequelize.STRING,
            unique: 'compsiteIndex',
        },
        service: {
            allowNull: false,
            type: Sequelize.STRING,
            unique: 'compsiteIndex',
        },
    },
    {
        charset: 'utf8mb4',
        collate: 'utf8mb4_general_ci',
    }
);

models.Post = sequelize.define(
    'post',
    {
        content: {
            allowNull: false,
            // eslint-disable-next-line new-cap
            type: Sequelize.TEXT( 'long' ),
        },
        id: {
            autoIncrement: true,
            primaryKey: true,
            type: Sequelize.INTEGER,
        },
        section: {
            type: Sequelize.STRING,
        },
        timestamp: {
            allowNull: false,
            type: Sequelize.INTEGER,
        },
        topic: {
            type: Sequelize.TEXT,
        },
        topicUrl: {
            type: Sequelize.TEXT,
        },
        url: {
            type: Sequelize.TEXT,
        },
        urlHash: {
            type: Sequelize.STRING,
            unique: true,
        },
        v1Id: {
            type: Sequelize.INTEGER,
        },
    },
    {
        charset: 'utf8mb4',
        collate: 'utf8mb4_general_ci',
    }
);

models.Game.hasMany( models.Developer, {
    foreignKey: {
        allowNull: false,
    },
    onDelete: 'CASCADE',
} );
models.Developer.hasMany( models.Account, {
    foreignKey: {
        allowNull: false,
    },
    onDelete: 'CASCADE',
} );
models.Account.hasMany( models.Post, {
    foreignKey: {
        allowNull: false,
    },
    onDelete: 'CASCADE',
} );
models.Post.belongsTo( models.Account, {
    foreignKey: {
        allowNull: false,
    },
    onDelete: 'CASCADE',
} );
models.Account.belongsTo( models.Developer, {
    foreignKey: {
        allowNull: false,
    },
    onDelete: 'CASCADE',
} );
models.Developer.belongsTo( models.Game, {
    foreignKey: {
        allowNull: false,
    },
    onDelete: 'CASCADE',
} );

models.sequelize = sequelize;

module.exports = models;
