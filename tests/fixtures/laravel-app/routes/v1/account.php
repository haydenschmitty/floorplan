<?php

use App\Http\Controllers\Api\AccountController;
use Illuminate\Support\Facades\Route;

Route::get('me', [AccountController::class, 'show'])->name('account.me');
