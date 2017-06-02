# -*- mode: ruby -*-
# vi: set ft=ruby :
Vagrant.configure(2) do |config|
    config.vm.box = "ubuntu/xenial64"
    config.vm.provision :shell, path: "scripts/vagrant-bootstrap.sh"
    config.vm.network "forwarded_port", guest: 3000, host: 3000
end
