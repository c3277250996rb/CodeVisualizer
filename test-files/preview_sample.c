#include <stdio.h>

/* Return the sum of all positive values in the array. */
int sum_positive(const int values[], int count) {
    int total = 0;

    // Ignore invalid input instead of reading beyond the array.
    if (values == NULL || count <= 0) {
        return 0;
    }

    // Visit each element once and accumulate only positive numbers.
    for (int index = 0; index < count; index++) {
        if (values[index] > 0) {
            total += values[index];
        }
    }

    return total;
}

int main(void) {
    const int values[] = { 4, -2, 7, 0, 3 };
    const int result = sum_positive(values, 5);

    printf("Positive sum: %d\n", result);
    return 0;
}