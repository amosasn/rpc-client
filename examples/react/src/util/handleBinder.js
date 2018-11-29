// re-binds all object methods starting with 'handle',
// so that methods can be used detached from instance. For use in React

const startsWithHandle = /^handle/;

export default function handleBinder(ob) {
    const proto = Object.getPrototypeOf(ob);
    Object.getOwnPropertyNames(proto).forEach(propertyName => {
        const desc = Object.getOwnPropertyDescriptor(proto, propertyName);
        if (!!desc && typeof desc.value === 'function' && (startsWithHandle.test(propertyName))) {
            ob[propertyName] = desc.value.bind(ob);
        }
    })
}