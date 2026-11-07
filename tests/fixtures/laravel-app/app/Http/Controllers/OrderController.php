<?php

namespace App\Http\Controllers;

use App\Http\Requests\StoreOrderRequest;
use App\Models\Order;
use Illuminate\Http\RedirectResponse;
use Inertia\Inertia;
use Inertia\Response;

/**
 * The customer's orders: the list, one order, placing and changing an order.
 */
class OrderController extends Controller
{
    /** Every order the signed-in customer placed. */
    public function index(): Response
    {
        return Inertia::render('orders/index', ['orders' => Order::query()->latest()->get()]);
    }

    /**
     * One order with its items.
     */
    #[\Deprecated]
    public function show(Order $order): Response
    {
        return Inertia::render('orders/show', ['order' => $order->load('items')]);
    }

    public function store(StoreOrderRequest $request): RedirectResponse
    {
        $order = Order::create($request->validated());

        return redirect()->route('orders.show', $order);
    }

    public function update(Order $order): RedirectResponse
    {
        $order->update(request()->only('note'));

        return back();
    }
}
