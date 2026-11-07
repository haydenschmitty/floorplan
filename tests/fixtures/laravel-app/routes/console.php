<?php

use Illuminate\Support\Facades\Schedule;

Schedule::command('orders:prune')->daily();
