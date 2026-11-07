<?php

namespace App\Http\Controllers\Api;

use App\Http\Controllers\Controller;
use App\Http\Resources\OrderResource;
use App\Models\Order;

/**
 * Orders for the phone app.
 */
class OrderController extends Controller
{
    public function index()
    {
        return OrderResource::collection(Order::query()->paginate());
    }

    public function store()
    {
        return new OrderResource(Order::create(request()->all()));
    }

    public function show(Order $order)
    {
        return new OrderResource($order);
    }

    public function update(Order $order)
    {
        $order->update(request()->all());

        return new OrderResource($order);
    }
}
