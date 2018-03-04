const fs = require( 'fs' );
const path = require( 'path' );

const copyFile = function copyFile ( source, target, doneCallback ) {
    let cbCalled = false;

    const readStream = fs.createReadStream( source );

    readStream.on( 'error', ( error ) => {
        done( error );
    } );

    const writeStream = fs.createWriteStream( target );

    writeStream.on( 'error', ( error ) => {
        done( error );
    } );

    writeStream.on( 'close', () => {
        done();
    } );

    readStream.pipe( writeStream );

    const done = function done ( error ) {
        if ( !cbCalled ) {
            doneCallback( error );
            cbCalled = true;
        }
    };
};

copyFile( '/home/kokarn/letsencrypt/live/api.kokarn.com/fullchain.pem', path.join( __dirname, '../assets/fullchain.pem' ), ( copyError ) => {
    if ( copyError ) {
        throw copyError;
    }

    console.log( 'cert.pem copied successfully' );
} );

copyFile( '/home/kokarn/letsencrypt/live/api.kokarn.com/privkey.pem', path.join( __dirname, '../assets/privkey.pem' ), ( copyError ) => {
    if ( copyError ) {
        throw copyError;
    }

    console.log( 'privkey.pem copied successfully' );
} );
