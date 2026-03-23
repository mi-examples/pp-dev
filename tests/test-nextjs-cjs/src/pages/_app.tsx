import type { AppProps } from 'next/app';
import '../styles/tailwind.css';
import '../styles/global.scss';

export default function MyApp({ Component, pageProps }: AppProps) {
  return <Component {...pageProps} />;
}
