<?php

use App\Admin\ReportController;
use Symfony\Component\Routing\Loader\Configurator\RoutingConfigurator;

return static function (RoutingConfigurator $routes): void {
    $routes->import('../../src/Admin/', 'attribute')
        ->prefix('/admin')
        ->namePrefix('admin_');

    // added here, not imported: the /admin prefix doesn't apply
    $routes->add('admin_ping', '/ping')
        ->controller([ReportController::class, 'ping'])
        ->methods(['GET']);

    if ('dev' === $routes->env()) {
        $routes->import('../../src/Debug/', 'attribute')->prefix('/_debug');
    }
};
