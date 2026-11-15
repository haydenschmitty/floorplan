<?php

use App\Http\Controllers\Admin\ProductController;
use Illuminate\Support\Facades\Route;

Route::resource('products', ProductController::class)->only(['index', 'store', 'destroy']);
