#!/usr/bin/env bash

# Installing node.js
curl -sL https://deb.nodesource.com/setup_8.x | sudo -E bash -

apt-get update
apt-get upgrade -y

sudo debconf-set-selections <<< 'mysql-server mysql-server/root_password password root'
sudo debconf-set-selections <<< 'mysql-server mysql-server/root_password_again password root'

apt-get install -y nodejs mysql-server

# iptables -t nat -I PREROUTING -p tcp --dport 80 -j REDIRECT --to-ports 3000

systemctl status mysql.service
