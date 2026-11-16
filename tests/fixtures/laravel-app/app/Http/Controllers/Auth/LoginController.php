<?php

namespace App\Http\Controllers\Auth;

use App\Http\Controllers\Controller;
use Illuminate\Http\Request;
use Illuminate\Support\Facades\Auth;
use Inertia\Inertia;

class LoginController extends Controller
{
    public function show()
    {
        return Inertia::render('auth/login');
    }

    public function store(Request $request)
    {
        Auth::attempt($request->only('email', 'password'));

        return redirect()->intended('/orders');
    }
}
