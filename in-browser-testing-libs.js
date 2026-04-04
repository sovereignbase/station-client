import { StationClient } from './dist/index.js'
import { OOStruct } from '@sovereignbase/convergent-replicated-struct'

const station = new StationClient()
const snapshot = JSON.parse(localStorage.getItem('state')) ?? undefined
const state = new OOStruct(
  {
    name: '',
    amount: 0,
    flag: false,
  },
  snapshot
)

const nameInput = document.getElementById('name')

const amountInput = document.getElementById('amount')

const flagInput = document.getElementById('flag')

nameInput.value = state.read('name')
amountInput.value = state.read('amount')
flagInput.checked = state.read('flag')

nameInput.addEventListener('change', async (ev) => {
  state.update('name', ev.target.value)
  state.snapshot()
})

amountInput.addEventListener('change', async (ev) => {
  state.update('amount', ev.target.valueAsNumber)
  state.snapshot()
})

flagInput.addEventListener('change', async (ev) => {
  state.update('flag', ev.target.checked)
  state.snapshot()
})

state.addEventListener('snapshot', (ev) => {
  localStorage.setItem('state', JSON.stringify(ev.detail))
})

state.addEventListener('delta', (ev) => {
  station.postMessage(ev.detail)
})

station.addEventListener('message', (ev) => {
  state.merge(ev.detail)
})

state.addEventListener('change', (ev) => {
  const { name, amount, flag } = ev.detail
  if (name) nameInput.value = name
  if (amount) amountInput.value = amount
  if (flag) flagInput.checked = flag
})
