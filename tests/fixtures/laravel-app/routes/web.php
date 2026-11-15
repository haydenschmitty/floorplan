<?php

use App\Http\Controllers\Auth\LoginController;
use App\Http\Controllers\FeedbackController;
use App\Http\Controllers\QuoteController;
use App\Http\Controllers\ReportController;
use App\Http\Controllers\StatsController;
use Illuminate\Support\Facades\Route;

/*
|--------------------------------------------------------------------------
| Web routes
|--------------------------------------------------------------------------
| The shop's pages. Signed-in pages are in routes/shop.
*/

Route::get('/', fn () => redirect('/orders'));
Route::inertia('/about', 'about')->name('about');

Route::middleware('guest')->group(function () {
    Route::get('/login', [LoginController::class, 'show'])->name('login');
    Route::post('/login', [LoginController::class, 'store']);
});

Route::middleware(['auth', 'verified'])->group(function () {
    require __DIR__.'/shop/orders.php';
});

Route::prefix('admin')->name('admin.')->middleware('back-office')->group(base_path('routes/shop/admin.php'));

// the controller checks sign-in for show() itself; index() is left open
Route::get('/reports', [ReportController::class, 'index'])->name('reports.index');
Route::get('/reports/{report}', [ReportController::class, 'show'])->name('reports.show');

Route::post('/feedback', [FeedbackController::class, 'store'])->name('feedback.store');
// no middleware, but its form request checks the user
Route::post('/quotes', [QuoteController::class, 'store'])->name('quotes.store');
Route::get('/stats', StatsController::class)->name('stats');
