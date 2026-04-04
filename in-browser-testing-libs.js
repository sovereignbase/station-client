import { StationClient } from './dist/index.js'
import { OOStruct } from '@sovereignbase/convergent-replicated-struct'

const station = new StationClient()
const snapshot = JSON.parse(localStorage.getItem('state')) ?? undefined
const state = new OOStruct(
  {
    name: '',
    counter: 0,
    flag: false,
  },
  snapshot
)

const nameInput = document.getElementById('name')

const counterInput = document.getElementById('counter')

const flagInput = document.getElementById('flag')

nameInput.addEventListener('input', async (ev) => {
  state.update('name', ev.data)
  state.snapshot()
})

counterInput.addEventListener('input', async (ev) => {
  state.update('counter', ev.data)
  state.snapshot()
})

flagInput.addEventListener('input', async (ev) => {
  state.update('flag', ev.data)
  state.snapshot()
})

state.addEventListener('snapshot', (ev) => {
  localStorage.setItem('state', JSON.stringify(ev.detail))
})

state.addEventListener('delta', (ev) => {
  station.postMessage(ev.detail)
})

station.addEventListener('message', (ev) => {
  state.merge(ev)
})

state.addEventListener('change', (ev) => {
  const { name, counter, flag } = ev.detail
  if (name) nameInput.value = name
  if (counter) counterInput.value = counter
  if (flag) flagInput.value = flag
})
