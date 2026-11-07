<?php

use App\Http\Middleware\EnsureUserIsStaff;
use App\Http\Middleware\LogRequest;
use Illuminate\Foundation\Application;
use Illuminate\Foundation\Configuration\Middleware;
use Illuminate\Support\Facades\Route;

return Application::configure(basePath: dirname(__DIR__))
    ->withRouting(
        web: __DIR__.'/../routes/web.php',
        api: __DIR__.'/../routes/api.php',
        commands: __DIR__.'/../routes/console.php',
        health: '/up',
        then: function () {
            Route::get('/legal/terms', fn () => view('legal.terms'))->name('terms');
        },
    )
    ->withMiddleware(function (Middleware $middleware): void {
        $middleware->alias([
            'staff' => EnsureUserIsStaff::class,
            'log' => LogRequest::class,
        ]);
        // a group of our own: the request log, then the staff check
        $middleware->group('back-office', [
            'log',
            'staff',
        ]);
        $middleware->web(append: [LogRequest::class]);
    })
    ->create();
