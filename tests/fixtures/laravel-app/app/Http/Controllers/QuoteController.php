<?php

namespace App\Http\Controllers;

use App\Http\Requests\StoreQuoteRequest;

class QuoteController extends Controller
{
    public function store(StoreQuoteRequest $request)
    {
        $request->user()->quotes()->create($request->validated());

        return back();
    }
}
