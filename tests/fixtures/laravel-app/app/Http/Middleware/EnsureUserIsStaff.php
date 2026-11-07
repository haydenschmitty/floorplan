<?php

namespace App\Http\Middleware;

use Closure;
use Illuminate\Http\Request;

class EnsureUserIsStaff
{
    public function handle(Request $request, Closure $next)
    {
        abort_unless($request->user()?->is_staff, 403);

        return $next($request);
    }
}
