import { DateTime } from 'luxon';
console.log('Changed ts file');

console.log('New test message');

console.log(DateTime.now().toFormat('yyyy dd MMMM'));

export default {
  test: 1
}
