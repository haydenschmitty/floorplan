<?php

namespace App\Http\Controllers;

use App\Http\Requests\StoreFeedbackRequest;
use App\Models\Feedback;

class FeedbackController extends Controller
{
    public function store(StoreFeedbackRequest $request)
    {
        Feedback::create($request->validated());

        return back();
    }
}
