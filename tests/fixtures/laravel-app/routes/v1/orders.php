<?php

use App\Http\Controllers\Api;
use Illuminate\Support\Facades\Route;

Route::apiResource('orders', Api\OrderController::class)->except(['destroy']);
