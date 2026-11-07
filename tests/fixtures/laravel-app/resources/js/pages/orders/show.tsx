import orders from '@/routes/orders';
import { router } from '@inertiajs/react';

type Order = { id: number; note: string };

export default function OrderShow({ order }: { order: Order }) {
    const save = (note: string) => router.patch(orders.update.url(order.id), { note });
    return (
        <main>
            <a href={orders.index().url}>All orders</a>
            <textarea defaultValue={order.note} onBlur={(e) => save(e.target.value)} />
        </main>
    );
}
