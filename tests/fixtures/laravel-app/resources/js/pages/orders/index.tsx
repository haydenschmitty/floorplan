import OrderController from '@/actions/App/Http/Controllers/OrderController';
import { show } from '@/routes/orders';
import { Form, Link } from '@inertiajs/react';

type Order = { id: number; status: string };

export default function OrdersIndex({ orders }: { orders: Order[] }) {
    return (
        <main>
            <h1>Your orders</h1>
            {orders.map((order) => (
                <Link key={order.id} href={show(order.id).url}>
                    Order {order.id}: {order.status}
                </Link>
            ))}
            <Form {...OrderController.store.form()}>
                <button type="submit">Order again</button>
            </Form>
        </main>
    );
}
