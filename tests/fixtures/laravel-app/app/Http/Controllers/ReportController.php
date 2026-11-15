<?php

namespace App\Http\Controllers;

use App\Models\Order;
use Illuminate\Routing\Controllers\HasMiddleware;
use Illuminate\Routing\Controllers\Middleware;

class ReportController extends Controller implements HasMiddleware
{
    public static function middleware(): array
    {
        return [
            new Middleware('auth', only: ['show']),
        ];
    }

    public function index()
    {
        return ['count' => Order::query()->count()];
    }

    public function show(string $report)
    {
        return ['report' => $report, 'total' => Order::query()->sum('total')];
    }
}
