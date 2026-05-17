// Task Queue — FIFO task execution
// Handles task prioritization, retry logic, and tracking

const memory = require('../memory')

class TaskQueue {
  constructor() {
    this.tasks = []
    this.completed = []
    this.failed = []
    this.maxRetries = 3
  }
  
  // Add task to queue
  add(task) {
    const newTask = {
      id: Date.now().toString(),
      createdAt: new Date().toISOString(),
      retries: 0,
      status: 'pending',
      ...task
    }
    
    this.tasks.push(newTask)
    return newTask.id
  }
  
  // Get next task (FIFO)
  next() {
    return this.tasks.shift()
  }
  
  // Mark task complete
  complete(taskId, result) {
    const task = this.findTask(taskId, this.tasks)
    if (task) {
      this.tasks = this.tasks.filter(t => t.id !== taskId)
    }
    
    this.completed.push({
      taskId,
      result,
      completedAt: new Date().toISOString()
    })
  }
  
  // Mark task failed (with retry logic)
  fail(taskId, error) {
    const task = this.findTask(taskId, this.tasks)
    
    if (!task) {
      // Task not in queue, add to failed
      this.failed.push({
        taskId,
        error,
        failedAt: new Date().toISOString()
      })
      return
    }
    
    if (task.retries < this.maxRetries) {
      // Retry
      task.retries++
      task.lastError = error
      this.tasks.push(task) // Re-add to queue
      console.log(`[TaskQueue] Retrying ${taskId} (${task.retries}/${this.maxRetries})`)
    } else {
      // Max retries reached
      this.tasks = this.tasks.filter(t => t.id !== taskId)
      this.failed.push({
        taskId,
        error,
        retries: task.retries,
        failedAt: new Date().toISOString()
      })
      console.log(`[TaskQueue] Task ${taskId} failed after ${task.retries} retries`)
    }
  }
  
  // Find task in array by ID
  findTask(taskId, array) {
    return array.find(t => t.id === taskId)
  }
  
  // Get queue status
  status() {
    return {
      pending: this.tasks.length,
      completed: this.completed.length,
      failed: this.failed.length
    }
  }
  
  // Save queue state to working memory
  save() {
    memory.working.saveWorking('task_queue', {
      tasks: this.tasks,
      completed: this.completed,
      failed: this.failed
    })
  }
  
  // Load queue state from working memory
  load() {
    const saved = memory.working.loadWorking('task_queue')
    if (saved) {
      this.tasks = saved.tasks || []
      this.completed = saved.completed || []
      this.failed = saved.failed || []
    }
  }
}

module.exports = { TaskQueue }