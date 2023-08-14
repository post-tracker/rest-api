const api = require( './api.js' );

class Post {
    save ( game ) {
        const storeObject = {
            accountId: this.accountId,
            content: this.text,
            section: this.section,
            timestamp: this.timestamp,
            topic: this.topicTitle,
            topicUrl: this.topicUrl,
            url: this.url,
        };

        return api.post( `/${ game }/posts`, storeObject );
    }
}

module.exports = Post;