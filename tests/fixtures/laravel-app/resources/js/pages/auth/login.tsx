import { useForm } from '@inertiajs/react';

export default function Login() {
    const form = useForm({ email: '', password: '' });
    return (
        <form onSubmit={(e) => { e.preventDefault(); form.post('/login'); }}>
            <input value={form.data.email} onChange={(e) => form.setData('email', e.target.value)} />
            <button type="submit">Sign in</button>
        </form>
    );
}
