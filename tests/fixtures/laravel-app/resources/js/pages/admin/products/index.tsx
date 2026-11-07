import { destroy } from '@/routes/admin/products';
import { router } from '@inertiajs/react';

type Product = { id: number; name: string };

export default function ProductsIndex({ products }: { products: Product[] }) {
    return (
        <ul>
            {products.map((p) => (
                <li key={p.id}>
                    {p.name} <button onClick={() => router.delete(destroy.url(p.id))}>Remove</button>
                </li>
            ))}
        </ul>
    );
}
