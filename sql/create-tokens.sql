-- Schema for the API tokens table (DB-backed auth; see server.js).
-- Run by hand against the MySQL container (the `mysql` compose service):
-- rest-api has no sequelize.sync/migrations, so nothing creates this table
-- automatically. Seed the existing tokens separately (each row: name, the
-- token string, and a JSON array of scopes, e.g. ["posts:read"]).
--
-- For a zero-downtime cutover, seed the 7 current tokens with their existing
-- string values BEFORE deploying the new code; until then, the API_TOKENS env
-- var keeps unmigrated tokens working as a fallback (server.js: legacyAuthorize).
--
-- Scopes: posts:read posts:write posts:delete | accounts:read accounts:write
-- accounts:delete | developers:read developers:write | games:read games:write
-- | hashes:read | stats:read | tokens:manage | admin (admin grants all).

CREATE TABLE `tokens` (
    `id` INT NOT NULL AUTO_INCREMENT,
    `name` VARCHAR(255) DEFAULT NULL,
    `token` VARCHAR(255) NOT NULL,
    `scopes` JSON DEFAULT NULL,
    `active` TINYINT(1) NOT NULL DEFAULT 1,
    `createdAt` DATETIME NOT NULL,
    `updatedAt` DATETIME NOT NULL,
    PRIMARY KEY (`id`),
    UNIQUE KEY `tokens_token_unique` (`token`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_general_ci;

-- Example seed (replace <TOKEN> with the real value; one row per existing token):
-- INSERT INTO `tokens` (`name`, `token`, `scopes`, `active`, `createdAt`, `updatedAt`)
-- VALUES ('Finder', '<TOKEN>', '["posts:read","accounts:read","games:read"]', 1, NOW(), NOW());
