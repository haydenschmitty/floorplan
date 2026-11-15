<?php

namespace App\Http\Controllers;

use App\Models\Order;
use Illuminate\Support\Facades\Gate;

class StatsController extends Controller
{
    public function __invoke()
    {
        Gate::authorize('view-stats');

        return ['orders' => Order::query()->count()];
    }
}
