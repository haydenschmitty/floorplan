<?php

use App\Http\Controllers\Api\CarrierWebhookController;
use Illuminate\Support\Facades\Route;

Route::prefix('v1')->name('api.')->group(function () {
    Route::get('ping', fn () => ['ok' => true]);
    Route::post('webhooks/carrier', [CarrierWebhookController::class, 'handle']);

    Route::middleware('auth:sanctum')->group(function () {
        // one file per area, loaded in a loop
        foreach (['orders', 'account'] as $file) {
            if (is_file($path = __DIR__.'/v1/'.$file.'.php')) {
                require $path;
            }
        }
    });
});
