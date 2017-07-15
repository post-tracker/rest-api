#!/usr/bin/env bash

# Installing node.js
curl -sL https://deb.nodesource.com/setup_8.x | sudo -E bash -

apt-get update
apt-get upgrade -y

sudo debconf-set-selections <<< 'mysql-server mysql-server/root_password password root'
sudo debconf-set-selections <<< 'mysql-server mysql-server/root_password_again password root'

apt-get install -y nodejs mysql-server

# iptables -t nat -I PREROUTING -p tcp --dport 443 -j REDIRECT --to-ports 3000
openssl req -x509 -nodes -days 365 -newkey rsa:2048 -subj "/C=US/ST=Denial/L=Springfield/O=Dis/CN=localhost" -keyout /vagrant/rest-api/assets/privkey.pem -out /vagrant/rest-api/assets/fullchain.pem

sed -i -e 's/bind-address = 127.0.0.1/#bind-address = 127.0.0.1/g' /etc/mysql/mysql.conf.d/mysqld.cnf

mysql --user="root" --password="root" --execute="CREATE DATABASE devtracker;"
mysql --user="root" --password="root" --database="devtracker" --execute="CREATE USER 'test'@'%' IDENTIFIED BY 'test';"
mysql --user="root" --password="root" --execute="GRANT ALL PRIVILEGES ON *.* TO 'test'@'%' IDENTIFIED BY 'test' WITH GRANT OPTION; FLUSH PRIVILEGES;"

systemctl restart mysql.service

systemctl status mysql.service

cp /vagrant/scripts/dev.json /vagrant/config/config.json

openssl req -x509 -nodes -days 365 -newkey rsa:2048 -subj "/C=US/ST=Denial/L=Springfield/O=Dis/CN=localhost" -keyout /vagrant/assets/privkey.pem -out /vagrant/assets/fullchain.pem

npm i -g pm2
cd /vagrant
# mysql2 needs to be installed locally in the machine
npm i mysql2 --no-bin-links
pm2 start ecosystem.json
