<?php

namespace App\Http\Controllers\Admin;

use App\Http\Controllers\Controller;
use App\Models\Product;
use Inertia\Inertia;

class ProductController extends Controller
{
    public function index()
    {
        return Inertia::render('admin/products/index', ['products' => Product::all()]);
    }

    public function store()
    {
        Product::create(request()->all());

        return back();
    }

    public function destroy(Product $product)
    {
        $product->delete();

        return back();
    }
}
