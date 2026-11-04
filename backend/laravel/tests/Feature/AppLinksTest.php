<?php

it('hides the association files until an app identity is configured', function () {
    config()->set('native.android.fingerprints', '');
    config()->set('native.ios.app_id', '');

    $this->get('/.well-known/assetlinks.json')->assertNotFound();
    $this->get('/.well-known/apple-app-site-association')->assertNotFound();
});

it('delegates Android app links to the configured package', function () {
    config()->set('native.android.package', 'cyberia.app');
    config()->set('native.android.fingerprints', 'aa:bb:cc , dd:ee:ff');

    $this->get('/.well-known/assetlinks.json')
        ->assertOk()
        ->assertJson([[
            'relation' => ['delegate_permission/common.handle_all_urls'],
            'target' => [
                'namespace' => 'android_app',
                'package_name' => 'cyberia.app',
                'sha256_cert_fingerprints' => ['AA:BB:CC', 'DD:EE:FF'],
            ],
        ]]);
});

it('claims every path for the configured iOS app', function () {
    config()->set('native.ios.app_id', 'ABCDE12345.church.cyberia.app');

    $this->get('/.well-known/apple-app-site-association')
        ->assertOk()
        ->assertHeader('content-type', 'application/json')
        ->assertJson([
            'applinks' => [
                'details' => [[
                    'appIDs' => ['ABCDE12345.church.cyberia.app'],
                    'components' => [['/' => '*']],
                ]],
            ],
            'webcredentials' => ['apps' => ['ABCDE12345.church.cyberia.app']],
        ]);
});
