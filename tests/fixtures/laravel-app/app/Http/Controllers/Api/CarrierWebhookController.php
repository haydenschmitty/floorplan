<?php

namespace App\Http\Controllers\Api;

use App\Http\Controllers\Controller;
use App\Models\Order;
use Illuminate\Http\Request;

/**
 * Delivery updates the carrier sends when a parcel moves.
 */
class CarrierWebhookController extends Controller
{
    public function handle(Request $request)
    {
        Order::query()->where('tracking', $request->input('tracking'))->update(['status' => $request->input('status')]);

        return response()->noContent();
    }
}
